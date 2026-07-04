import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SupervisionScopeMode, SupervisionStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

// query boolean 从 GET query string 解析:原始值是字符串 'true'/'false',@Type(() => Boolean)
// 会用 `Boolean(value)` 转换 —— 任何非空字符串(含 'false')都会变 true,是已知陷阱,
// 故显式判等而非用 @Type(沿 F1–F5 各 DTO 文件同名 helper 惯例,本仓约定按 DTO 文件各自持有一份,不抽共享)。
const parseQueryBoolean = ({ value }: { value: unknown }): unknown =>
  value === true || value === 'true' ? true : value === false || value === 'false' ? false : value;

// 终态 scoped-authz PR5(2026-07-01;冻结稿 §3.5 / §7.4):分管(supervision-assignments)CRUD + 查询 DTO 集合。
// 出参显式列字段(永不含 deletedAt);入参严格白名单(全局 ValidationPipe forbidNonWhitelisted 兜底)。
// status / *ByUserId / 时间戳(除任期)由 service 写;supervisor/org 身份仅 create 传、PATCH 不可改(只改 scopeMode/任期/note)。

// 展示层「谁分管此组织」的覆盖来源(非 DB 字段;直接分管 vs 因祖先 TREE 分管而被覆盖)。
export type SupervisionCoverage = 'DIRECT' | 'INHERITED';

// ============ F5/E2 expand 展开子对象(路线图 §4;D6 约定沿 F2–F4 落地形态)============

export const SUPERVISION_EXPAND_TOKENS = ['supervisor', 'organization'] as const;
export type SupervisionExpandToken = (typeof SUPERVISION_EXPAND_TOKENS)[number];

// 仅 `?expand=supervisor` 命中时出现。独立 admin-surface class,不 extends / Pick / Omit(沿本仓隔离惯例)。
export class SupervisionExpandedSupervisorDto {
  @ApiProperty({ description: '分管人队员主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '队员业务编号' })
  memberNo!: string;

  @ApiProperty({ description: '队员显示名' })
  displayName!: string;

  @ApiPropertyOptional({ description: '等级字典 code', nullable: true })
  gradeCode!: string | null;
}

// 仅 `?expand=organization` 命中时出现。
export class SupervisionExpandedOrganizationDto {
  @ApiProperty({ description: '组织节点主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '组织名称' })
  name!: string;

  @ApiPropertyOptional({ description: '组织缩写(可空)', nullable: true })
  code!: string | null;

  @ApiProperty({ description: '节点类型字典 code' })
  nodeTypeCode!: string;
}

// ============ 出参:分管记录 ============

export class SupervisionAssignmentResponseDto {
  @ApiProperty({ description: '主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: '分管人队员外键(指向 members.id)' })
  supervisorMemberId!: string;

  @ApiProperty({ description: '被分管组织外键(指向 organizations.id)' })
  organizationId!: string;

  @ApiProperty({
    description: '分管范围模式(EXACT 仅该节点 / TREE 含全部下级)',
    enum: SupervisionScopeMode,
    example: SupervisionScopeMode.TREE,
  })
  scopeMode!: SupervisionScopeMode;

  @ApiProperty({
    description: '分管状态(ACTIVE 在任 / ENDED 已结束 / REVOKED 已撤销)',
    enum: SupervisionStatus,
    example: SupervisionStatus.ACTIVE,
  })
  status!: SupervisionStatus;

  @ApiProperty({ description: '分管任期起' })
  startedAt!: Date;

  @ApiPropertyOptional({ description: '分管任期止(为空表示仍在任)', nullable: true })
  endedAt!: Date | null;

  @ApiPropertyOptional({ description: '指派人 userId', nullable: true })
  appointedByUserId!: string | null;

  @ApiPropertyOptional({ description: '撤销人 userId', nullable: true })
  revokedByUserId!: string | null;

  @ApiPropertyOptional({ description: '备注', nullable: true })
  note!: string | null;

  @ApiProperty({ description: '记录创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;

  @ApiPropertyOptional({
    description:
      '分管人摘要(仅 GET /supervision-assignments/page 且 ?expand 含 supervisor 时返回;默认省略)',
    type: () => SupervisionExpandedSupervisorDto,
  })
  supervisor?: SupervisionExpandedSupervisorDto;

  @ApiPropertyOptional({
    description:
      '组织摘要(仅 GET /supervision-assignments/page 且 ?expand 含 organization 时返回;默认省略)',
    type: () => SupervisionExpandedOrganizationDto,
  })
  organization?: SupervisionExpandedOrganizationDto;
}

// ============ F5/E2 入参:分页总表(GET /supervision-assignments/page;D9 同型) ============

// 旧 GET /supervision-assignments(bare 数组,仅 ACTIVE)逐字不动;本 DTO 只服务新 /page 兄弟路由。
export class PageSupervisionAssignmentsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按分管人队员精确过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  supervisorMemberId?: string;

  @ApiPropertyOptional({ description: '按被分管组织精确过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  organizationId?: string;

  @ApiPropertyOptional({
    description: '配合 organizationId:是否展开其全部后代组织(默认 false)',
    default: false,
  })
  @IsOptional()
  @Transform(parseQueryBoolean)
  @IsBoolean()
  includeDescendants?: boolean;

  @ApiPropertyOptional({ description: '按范围模式过滤', enum: SupervisionScopeMode })
  @IsOptional()
  @IsEnum(SupervisionScopeMode)
  scopeMode?: SupervisionScopeMode;

  @ApiPropertyOptional({
    description:
      '按分管状态过滤(缺省 = 全部未软删,含 REVOKED 历史 —— 总表口径,与旧数组端点「仅 ACTIVE」刻意不同)',
    enum: SupervisionStatus,
  })
  @IsOptional()
  @IsEnum(SupervisionStatus)
  status?: SupervisionStatus;

  @ApiPropertyOptional({
    description:
      '模糊搜索(命中分管人 memberNo+displayName + 组织 name+code;contains + insensitive)',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    description:
      'expand 展开(逗号分隔白名单:supervisor,organization;缺省 = 不展开,响应形状与旧端点一致)',
    example: 'supervisor,organization',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  expand?: string;
}

// ============ F5/E2 入参:覆盖范围预演(POST /supervision-assignments/coverage-preview) ============

// dry-run 展示「某待建分管将覆盖哪些组织」:EXACT=[organizationId];TREE=closure 展开(该组织+全部后代)。
// **纯展示读 closure,绝非判权;零写入**(建前给运营看清覆盖面,建后同信息可经 supervision-scope 查)。
export class SupervisionCoveragePreviewDto {
  @ApiProperty({ description: '拟被分管组织 id(须存在,未软删)', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  organizationId!: string;

  @ApiPropertyOptional({
    description: '范围模式(默认 TREE,与 create 默认一致)',
    enum: SupervisionScopeMode,
    default: SupervisionScopeMode.TREE,
  })
  @IsOptional()
  @IsEnum(SupervisionScopeMode)
  scopeMode?: SupervisionScopeMode;
}

// ============ F5/E2 出参:覆盖范围预演结果 ============

export class SupervisionCoveragePreviewResponseDto {
  @ApiProperty({ description: '拟被分管组织 id(入参回显)' })
  organizationId!: string;

  @ApiProperty({ description: '生效的范围模式(缺省补 TREE 后回显)', enum: SupervisionScopeMode })
  scopeMode!: SupervisionScopeMode;

  @ApiProperty({
    description: '将覆盖的组织 id 集(EXACT=[organizationId];TREE=该组织+全部后代,含自身)',
    type: [String],
  })
  expandedOrganizationIds!: string[];
}

// ============ 出参:某分管人的分管范围(展开;GET /members/:memberId/supervision-scope) ============

// 一条 active 分管 → 一条 scope 项;TREE 经 organization_closure 展开为「该组织 + 全部后代」,EXACT 仅该节点。
// **展示/报表读 closure,绝非判权**。
export class SupervisionScopeEntryDto {
  @ApiProperty({ description: '来源分管记录 id' })
  supervisionAssignmentId!: string;

  @ApiProperty({ description: '被分管组织 id(scope 根)' })
  organizationId!: string;

  @ApiProperty({
    description: '范围模式(EXACT 仅该节点 / TREE 含全部下级)',
    enum: SupervisionScopeMode,
    example: SupervisionScopeMode.TREE,
  })
  scopeMode!: SupervisionScopeMode;

  @ApiProperty({
    description:
      '展开后覆盖的组织 id 集(EXACT=[organizationId];TREE=organizationId + 全部后代,含自身)',
    type: [String],
  })
  expandedOrganizationIds!: string[];
}

// ============ 出参:某组织被谁分管(GET /organizations/:orgId/supervisors) ============

// 直接分管(该组织本身有 active 分管)+ 继承分管(某祖先有 active TREE 分管而覆盖本组织)。
// **展示读 closure 祖先集,绝非判权**。
export class OrganizationSupervisorDto {
  @ApiProperty({
    description: '覆盖来源(DIRECT 直接分管本组织 / INHERITED 因祖先 TREE 分管而被覆盖)',
    enum: ['DIRECT', 'INHERITED'],
    example: 'DIRECT',
  })
  coverage!: SupervisionCoverage;

  @ApiProperty({ description: '分管记录', type: SupervisionAssignmentResponseDto })
  supervisionAssignment!: SupervisionAssignmentResponseDto;
}

// ============ 入参:建分管(POST /supervision-assignments) ============

// 严格白名单:**禁止** id / status / *ByUserId / 时间戳(除任期)/ deletedAt。
// scopeMode 可空(默认 TREE,沿 schema @default);**不校验 supervisor 是否持职务**(分管与职务正交)。
export class CreateSupervisionAssignmentDto {
  @ApiProperty({
    description: '分管人队员 id(必须存在且 active;不要求持任何职务)',
    example: 'cl9z3a8b00000abcd1234efgh',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64)
  supervisorMemberId!: string;

  @ApiProperty({
    description: '被分管组织 id(必须存在且 active)',
    example: 'cl9z3a8b00000abcd1234efgh',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64)
  organizationId!: string;

  @ApiPropertyOptional({
    description: '分管范围模式(默认 TREE 含全部下级;EXACT 仅该节点)',
    enum: SupervisionScopeMode,
    default: SupervisionScopeMode.TREE,
  })
  @IsOptional()
  @IsEnum(SupervisionScopeMode)
  scopeMode?: SupervisionScopeMode;

  @ApiProperty({ description: '分管任期起(ISO 8601;必填)', example: '2026-07-01T00:00:00.000Z' })
  @IsDateString()
  startedAt!: string;

  @ApiPropertyOptional({
    description: '分管任期止(ISO 8601;可空;有值须晚于任期起)',
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

// ============ 入参:改分管(PATCH /supervision-assignments/:id) ============

// 只改 scopeMode / 任期 / note;**不可改** supervisor / organization(正交身份不变,换分管人=撤旧建新)。
export class UpdateSupervisionAssignmentDto {
  @ApiPropertyOptional({
    description: '分管范围模式(EXACT 仅该节点 / TREE 含全部下级)',
    enum: SupervisionScopeMode,
  })
  @IsOptional()
  @IsEnum(SupervisionScopeMode)
  scopeMode?: SupervisionScopeMode;

  @ApiPropertyOptional({ description: '分管任期起(ISO 8601)', example: '2026-07-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  startedAt?: string;

  @ApiPropertyOptional({
    description: '分管任期止(ISO 8601;有值须晚于任期起)',
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
