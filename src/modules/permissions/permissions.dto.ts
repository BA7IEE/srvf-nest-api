import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import {
  PERMISSION_CATALOG_STATUSES,
  PERMISSION_GRANT_POLICIES,
  PERMISSION_RISK_LEVELS,
  PERMISSION_RISK_TAGS,
  PERMISSION_UI_VISIBILITIES,
} from './permission-catalog';
import type {
  PermissionCatalogStatus,
  PermissionGrantPolicy,
  PermissionRiskLevel,
  PermissionRiskTag,
  PermissionUiVisibility,
} from './permission-catalog';

// V2.x C-6 RBAC 实施 PR #2:permissions 模块 DTO 集合。
// 沿 D7 v1.1 §5.2.1(CreatePermissionDto)+ §4.2(Permission schema)。
//
// **code 格式校验铁律(D2 v1.0 锁定 + 30008 实装方式)**:
// - DTO 层只做基础字符串 + 长度校验(@IsString + @MinLength(5) + @MaxLength(80))
// - **不在 DTO 写 @Matches**,把格式校验留给 Service 层显式 regex 检查 + 抛
//   BizException(BizCode.INVALID_PERMISSION_CODE_FORMAT)(30008),让本 BizCode
//   真正可触发并被 e2e 覆盖
// - 若放在 DTO @Matches,失败时 ValidationPipe 走通用 BAD_REQUEST(40000),
//   30008 永远不会被触发,违背"实装"语义
//
// **PATCH 字段白名单**
// (纵深防御铁律,沿 baseline §4.2 + docs/reference/naming-dto-validation.md §11):
// - UpdatePermissionDto 仅允许 description(且可空)
// - 严禁 code / module / action / resourceType / id / createdAt / updatedAt;
//   code 是业务标识不可改;module/action/resourceType 改了等于改语义,需走 DELETE+POST

// ============ 出参 ============

export class PermissionResponseDto {
  @ApiProperty({ description: '主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({
    description:
      '权限点 code,格式 <module>.<action>.<resource_type>[.<scope>](D2 v1.2;kebab-case 3-4 段,scope 可选)',
    example: 'attachment.upload.cert.self',
  })
  code!: string;

  @ApiProperty({ description: '模块名(冗余存储,后台 UI 按 module 分组)', example: 'attachment' })
  module!: string;

  @ApiProperty({ description: '动作', example: 'upload' })
  action!: string;

  @ApiProperty({ description: '资源类型', example: 'cert' })
  resourceType!: string;

  @ApiPropertyOptional({ description: '描述(可空;运营录入)' })
  description?: string | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// ============ 权限目录只读投影(P1-32 PR 2;冻结稿 §9.1)============
//
// 🔴 **纯 additive**:本段只**新增** DTO,`PermissionResponseDto` 一个字段都没动 ——
//    `GET /permissions`(分页)的响应体逐字保持原样,旧前端零影响。
//
// 形状沿冻结稿 §9.1 的 `PermissionCatalogResponseDto` / `PermissionCatalogItemDto`,
// 两处刻意与建议稿不同,理由写在 permission-catalog.presenter.ts 头注:
//   · 不出 `catalogVersion` / `catalogHash`(前者无事实源;后者的消费方在 PR 4b/5);
//   · 不出 `technicalDescription` / `replacementCodes`(PR 0 刻意一条都没落地,无数据可返)。

export class PermissionCatalogItemDto {
  @ApiProperty({ description: '权限码', example: 'org.create.node' })
  code!: string;

  @ApiProperty({ description: '中文名(给人看的短标签)', example: '新建分队/小组' })
  displayName!: string;

  @ApiProperty({
    description:
      '人话说明:这条权限允许做什么、有什么后果。**目录中文可用的落点** —— 后台权限编辑器直接展示本字段。',
    example: '在组织架构里加一个新的分队、部门或小组,挂到指定的上级下面。',
  })
  businessDescription!: string;

  @ApiProperty({ description: '模块名(权限码第一段)', example: 'org' })
  module!: string;

  @ApiProperty({ description: '动作(权限码第二段)', example: 'create' })
  action!: string;

  @ApiProperty({ description: '资源类型(权限码第三段)', example: 'node' })
  resourceType!: string;

  @ApiProperty({ description: '所属一级业务区 code', example: 'organization-people' })
  sectionCode!: string;

  @ApiProperty({ description: '所属二级分组 code', example: 'organization-structure' })
  groupCode!: string;

  @ApiProperty({ description: '组内排序(正整数,越小越靠前)', example: 10510 })
  sortOrder!: number;

  @ApiProperty({
    description: '风险等级(CRITICAL = 出错救不回,或能把权力给出去)',
    enum: [...PERMISSION_RISK_LEVELS],
  })
  riskLevel!: PermissionRiskLevel;

  @ApiProperty({
    description: '风险性质标签(多值;描述这个动作是什么性质,与等级分工不同)',
    enum: [...PERMISSION_RISK_TAGS],
    isArray: true,
  })
  riskTags!: PermissionRiskTag[];

  @ApiProperty({
    description: '授予策略:这条码允许被放进什么样的角色',
    enum: [...PERMISSION_GRANT_POLICIES],
  })
  grantPolicy!: PermissionGrantPolicy;

  @ApiProperty({ description: '生命周期状态', enum: [...PERMISSION_CATALOG_STATUSES] })
  status!: PermissionCatalogStatus;

  @ApiProperty({
    description: '在角色编辑器里的露面程度(HIDDEN = 不该出现在选择器里)',
    enum: [...PERMISSION_UI_VISIBILITIES],
  })
  uiVisibility!: PermissionUiVisibility;
}

export class PermissionCatalogGroupDto {
  @ApiProperty({ description: '二级分组 code', example: 'organization-structure' })
  code!: string;

  @ApiProperty({ description: '二级分组中文名', example: '组织架构' })
  displayName!: string;

  @ApiProperty({ description: '区内排序(越小越靠前)', example: 10 })
  sortOrder!: number;

  @ApiProperty({
    description: '本分组下的权限条目(按 sortOrder 升序;分组下无条目时返 [])',
    type: () => [PermissionCatalogItemDto],
  })
  items!: PermissionCatalogItemDto[];
}

export class PermissionCatalogSectionDto {
  @ApiProperty({ description: '一级业务区 code', example: 'organization-people' })
  code!: string;

  @ApiProperty({ description: '一级业务区中文名', example: '组织与人员' })
  displayName!: string;

  @ApiProperty({ description: '全局排序(越小越靠前)', example: 100 })
  sortOrder!: number;

  @ApiProperty({
    description: '本业务区下的二级分组(按 sortOrder 升序)',
    type: () => [PermissionCatalogGroupDto],
  })
  groups!: PermissionCatalogGroupDto[];
}

export class PermissionCatalogResponseDto {
  @ApiProperty({
    description:
      '目录条目总数(= 全部业务区/分组下 items 数之和)。前端可用它自证「拿全了没有」,不必自己遍历求和。',
    example: 237,
  })
  totalItems!: number;

  @ApiProperty({
    description: '按一级业务区分组的完整目录(按 sortOrder 升序;一次返回全量,不分页)',
    type: () => [PermissionCatalogSectionDto],
  })
  sections!: PermissionCatalogSectionDto[];
}

// ============ 入参 ============

export class CreatePermissionDto {
  @ApiProperty({
    description:
      'code,格式 <module>.<action>.<resource_type>[.<scope>](D2 v1.2 锁定 kebab-case;3-4 段点分隔,scope 可选;详见 service 层 regex 校验 / 失败抛 30008)',
    example: 'attachment.upload.cert.self',
    minLength: 1,
    maxLength: 80,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  code!: string;

  @ApiProperty({ description: '模块名', example: 'attachment', maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  module!: string;

  @ApiProperty({ description: '动作', example: 'upload', maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  action!: string;

  @ApiProperty({ description: '资源类型', example: 'cert', maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  resourceType!: string;

  @ApiPropertyOptional({ description: '描述(可空)', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

// PATCH 仅允许 description;严禁 code / module / action / resourceType / id 等敏感字段
// (沿 baseline §4.2 / docs/reference/naming-dto-validation.md §11 纵深防御)。
export class UpdatePermissionDto {
  @ApiPropertyOptional({ description: '描述(可空)', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class ListPermissionsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按 module 过滤(精确匹配)', example: 'attachment' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  module?: string;

  @ApiPropertyOptional({ description: '按 resourceType 过滤(精确匹配)', example: 'cert' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  resourceType?: string;
}
