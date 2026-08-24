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
import { PERMISSION_RISK_LEVELS } from './permission-catalog';
import type { PermissionRiskLevel } from './permission-catalog';
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

// ============================================================================
// P1-32 PR 4b(2026-08-24):读 / 预览面出参(冻结稿 §9.2 / §9.3)
//
// 🔴 **本段全是出参,一个入参都没有** —— `preview` 刻意**复用 `ReplaceRolePermissionsDto`**
//    而不是另建一个 `PreviewRolePermissionsDto`。入参同一个类 ⇒ 「预览的是不是那次提交」
//    在类型层面就是同一件事;另建一份就得靠人保证两个 DTO 的字段与校验永远一致,
//    而它们分家之后没有任何症状(预览校验松一格,提交时才 40000)。
// ============================================================================

/** 角色摘要(冻结稿 §9.2 的 `role` 块)。三个分类字段来自 `classifyRole()`,不是 DB 列。 */
export class RolePermissionSetRoleDto {
  @ApiProperty({ description: '角色 id(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: '角色 code(kebab-case)', example: 'icc-attendance-reviewer' })
  code!: string;

  @ApiProperty({ description: '显示名', example: 'ICC 考勤审核员' })
  displayName!: string;

  @ApiProperty({
    description: '角色类型(派生;`SYSTEM` = 15 个内建角色之一)',
    enum: [...ROLE_KINDS],
    example: 'CUSTOM',
  })
  kind!: RoleKind;

  @ApiProperty({
    description:
      '权限集由谁管(派生)。`RELEASE_MANAGED` = 随版本发布走 seed,运行时任何人加减权限都返 30108',
    enum: [...PERMISSION_MANAGEMENT_MODES],
    example: 'ADMIN_EDITABLE',
  })
  permissionManagementMode!: PermissionManagementMode;

  @ApiProperty({
    description: '角色绑定由谁管(派生)',
    enum: [...BINDING_MANAGEMENT_MODES],
    example: 'MANUAL_ALLOWED',
  })
  bindingManagementMode!: BindingManagementMode;
}

/**
 * 权限集编辑策略(冻结稿 §9.2 的 `editPolicy`)。
 *
 * ⚠️ **本期只出 `canEdit` / `readOnlyReason` 两个字段。** 冻结稿同一个块里还有
 *    `addBlocked[]` / `removeBlocked[]`(「哪些码**你**加不了 / 撤不了」)——
 *    那两项属 PR 5,理由见 controller 头注的「划给 PR 5 的四项」。
 */
export class RolePermissionSetEditPolicyDto {
  @ApiProperty({
    description:
      '这个角色的权限集能不能被运行时改。**问的是角色,不是你** —— ' +
      '调用者自身的判权与控制面分级闸另算(见 PUT 的错误码清单)。' +
      '取值恒等于 `role.permissionManagementMode === ADMIN_EDITABLE`。',
    example: true,
  })
  canEdit!: boolean;

  @ApiProperty({
    description:
      '只读原因码(`canEdit=false` 时非空,否则为 `null`)。' +
      '当前唯一取值 `SYSTEM_ROLE_PERMISSION_SET_RELEASE_MANAGED` —— 内建角色的权限集随版本发布走 seed。',
    nullable: true,
    example: null,
  })
  readOnlyReason!: string | null;
}

/** `GET /api/system/v1/roles/{id}/permissions` 的响应体(冻结稿 §9.2)。 */
export class RolePermissionSetResponseDto {
  @ApiProperty({ type: () => RolePermissionSetRoleDto })
  role!: RolePermissionSetRoleDto;

  @ApiProperty({
    description:
      '权限集版本号(P1-32 PR 4a)。**拿它去填 `PUT` / `preview` 的 `expectedRevision`** —— ' +
      '期间被别人改过就返 30111,不会覆盖对方的改动。',
    example: 7,
  })
  permissionRevision!: number;

  @ApiProperty({
    description:
      '该角色当前持有的权限码全集(**已按 code 升序排序、无重复**;未分配任何权限时返 `[]`)。' +
      '排序是服务端保证的,前端可直接与 `permissions/catalog` 的勾选状态做集合比对。',
    type: [String],
    example: ['attendance.approve.sheet', 'attendance.read.sheet'],
  })
  permissionCodes!: string[];

  @ApiProperty({ type: () => RolePermissionSetEditPolicyDto })
  editPolicy!: RolePermissionSetEditPolicyDto;
}

/**
 * 差集条目(冻结稿 §9.3 `diff.added[]` / `diff.removed[]`)。
 *
 * `displayName` / `riskLevel` 是 `permissions/catalog` 元数据的**纯投影**,不是新判定:
 * 让人在按下保存前看见「我要撤掉的这条是 CRITICAL」。
 * ⚠️ 目录里查不到该码(仅历史脏数据可能出现)时两者为 `null`,而**不是**静默丢掉这一条 ——
 * 丢掉会让「差集里少一条」变成零症状。
 */
export class RolePermissionDiffItemDto {
  @ApiProperty({ description: '权限码', example: 'attendance.approve.sheet' })
  code!: string;

  @ApiProperty({
    description: '中文名(取自权限目录;目录里没有该码时为 null)',
    nullable: true,
    example: '考勤一审通过',
  })
  displayName!: string | null;

  @ApiProperty({
    description: '风险等级(取自权限目录;目录里没有该码时为 null)',
    enum: [...PERMISSION_RISK_LEVELS],
    nullable: true,
    example: 'HIGH',
  })
  riskLevel!: PermissionRiskLevel | null;
}

/**
 * 预览结论(`valid=true` 时非空)。
 *
 * 🔴 **它是真判定跑完之后的结果,不是重算的估计** —— 与 `PUT` 走同一条原语、
 *    同一把角色行锁、同一个事务,只是在写库前一步停下(见 service 的 `commitMeta === null`)。
 */
export class RolePermissionPreviewOutcomeDto {
  @ApiProperty({
    description: '空转:目标集合与现状**相同** ⇒ 真提交时不写、不 +1、不留审计痕迹',
    example: false,
  })
  noOp!: boolean;

  @ApiProperty({ description: '库中当前的权限集版本号(锁内读到的真值)', example: 7 })
  currentRevision!: number;

  @ApiProperty({
    description:
      '真提交后的版本号**预测值**(`noOp=true` 时等于 `currentRevision`)。' +
      '⚠️ 是预测不是承诺:预览到提交之间别人改了,提交会返 30111 而不是悄悄用这个数。',
    example: 8,
  })
  nextRevision!: number;

  @ApiProperty({ description: '会被加上的权限码', type: () => [RolePermissionDiffItemDto] })
  added!: RolePermissionDiffItemDto[];

  @ApiProperty({ description: '会被撤销的权限码', type: () => [RolePermissionDiffItemDto] })
  removed!: RolePermissionDiffItemDto[];

  @ApiProperty({ description: '既在现状又在目标里、这次不动的条数', example: 1 })
  unchangedCount!: number;

  @ApiProperty({
    description: '真提交后该角色会持有的权限码全集(已按 code 升序排序)',
    type: [String],
    example: ['attendance.approve.sheet', 'attendance.read.sheet'],
  })
  resultCodes!: string[];
}

/**
 * 拦下来的原因(冻结稿 §9.3「deny/blocked 作为 200 数据返回」)。
 *
 * `bizCode` 与真提交时 `PUT` 会抛的那个码**逐字相同** —— 它就是同一个异常搬过来的,
 * 不存在「预览一套码、提交另一套码」。
 */
export class RolePermissionPreviewIssueDto {
  @ApiProperty({ description: '业务错误码(与 `PUT` 抛出的同一个)', example: 30111 })
  bizCode!: number;

  @ApiProperty({
    description: '人话原因(与 `PUT` 的错误响应同一句)',
    example: '该角色的权限集已被其他人修改,请刷新后重新提交',
  })
  message!: string;

  @ApiProperty({ description: 'HTTP 语义(`PUT` 走错误响应时会用的状态码)', example: 409 })
  httpStatus!: number;
}

/** `POST /api/system/v1/roles/{id}/permissions/preview` 的响应体(冻结稿 §9.3)。 */
export class RolePermissionPreviewResponseDto {
  @ApiProperty({
    description:
      '这次替换**此刻**能不能提交。`true` ⟺ 同一时刻 `PUT` 会成功(同一段判定、同一把锁算出来的)。',
    example: true,
  })
  valid!: boolean;

  @ApiProperty({
    description:
      '拦下来的原因。**长度恒为 0 或 1** —— 写路径本身是 fail-fast(第一道闸拦下就不跑后面的),' +
      '硬凑成多条就得在锁外另跑一遍判定,那正是本端点要避免的第二份真相。' +
      '⚠️ 所以它**不是全量诊断**:修掉这一条之后可能还有下一条。',
    type: () => [RolePermissionPreviewIssueDto],
  })
  blockingIssues!: RolePermissionPreviewIssueDto[];

  @ApiProperty({
    description: '预览结论;被拦下时(`valid=false`)为 `null`',
    type: () => RolePermissionPreviewOutcomeDto,
    nullable: true,
  })
  outcome!: RolePermissionPreviewOutcomeDto | null;
}
