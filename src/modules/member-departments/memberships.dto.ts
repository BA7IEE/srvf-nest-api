import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MembershipStatus, MembershipType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

// query boolean 从 GET query string 解析:原始值是字符串 'true'/'false',@Type(() => Boolean)
// 会用 `Boolean(value)` 转换 —— 任何非空字符串(含 'false')都会变 true,是已知陷阱,
// 故显式判等而非用 @Type(沿 F1–F3 各 DTO 文件同名 helper 惯例,本仓约定按 DTO 文件各自持有一份,不抽共享)。
const parseQueryBoolean = ({ value }: { value: unknown }): unknown =>
  value === true || value === 'true' ? true : value === false || value === 'false' ? false : value;

// 终态 scoped-authz PR2(2026-07-01;冻结稿 §3.1 / §7.1):memberships 组织归属 CRUD DTO 集合。
// 出参显式列字段(永不含 deletedAt 软删内部状态);入参严格白名单。
// 旧 member-departments DTO(MemberDepartmentResponseDto / SetMemberDepartmentDto)保留一版不动。
//
// 与旧单部门 DTO 的差异:memberships 面显式承载 membershipType / status / 任期(startedAt/endedAt)/ reason,
// 支持主(PRIMARY)/兼(SECONDARY)/临时(TEMPORARY)/支援(SUPPORT)多条并存 + 历史留痕。

// ============ F4/D 组 expand 展开子对象(路线图 §4;D6 约定沿 F2/F3 落地形态)============

export const MEMBERSHIP_EXPAND_TOKENS = ['member', 'organization'] as const;
export type MembershipExpandToken = (typeof MEMBERSHIP_EXPAND_TOKENS)[number];

// 仅 `?expand=member` 命中时出现在响应里。独立 admin-surface class,不 extends / Pick / Omit(沿本仓隔离惯例)。
export class MembershipExpandedMemberDto {
  @ApiProperty({ description: '队员主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '队员业务编号' })
  memberNo!: string;

  @ApiProperty({ description: '队员显示名' })
  displayName!: string;

  @ApiPropertyOptional({ description: '等级字典 code', nullable: true })
  gradeCode!: string | null;
}

// 仅 `?expand=organization` 命中时出现在响应里。
export class MembershipExpandedOrganizationDto {
  @ApiProperty({ description: '组织节点主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '组织名称' })
  name!: string;

  @ApiPropertyOptional({ description: '组织业务编码(可空)', nullable: true })
  code!: string | null;

  @ApiProperty({ description: '节点类型字典 code' })
  nodeTypeCode!: string;
}

// ============ 出参 ============

// F4/D 组(路线图 §4;D6 拍板):+可选 member / organization(仅 GET /memberships 分页总表且
// expand 命中时才出现;既有队员轴 4 端点从不设置这两个字段,默认响应形状逐字不变,additive)。
export class MembershipResponseDto {
  @ApiProperty({ description: '主键(cuid 代理键)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: '队员外键(指向 members.id)' })
  memberId!: string;

  @ApiProperty({ description: '组织节点外键(指向 organizations.id)' })
  organizationId!: string;

  @ApiProperty({
    description: '归属类型(PRIMARY 主 / SECONDARY 兼 / TEMPORARY 临时 / SUPPORT 支援)',
    enum: MembershipType,
    example: MembershipType.PRIMARY,
  })
  membershipType!: MembershipType;

  @ApiProperty({
    description: '归属状态(ACTIVE 在任 / ENDED 已结束 / SUSPENDED 暂停)',
    enum: MembershipStatus,
    example: MembershipStatus.ACTIVE,
  })
  status!: MembershipStatus;

  @ApiProperty({ description: '任期起(归属生效时间)' })
  startedAt!: Date;

  @ApiPropertyOptional({ description: '任期止(为空表示仍在任)', nullable: true })
  endedAt!: Date | null;

  @ApiPropertyOptional({ description: '编入 / 调出原因(自由短串)', nullable: true })
  reason!: string | null;

  @ApiPropertyOptional({ description: '创建人 userId', nullable: true })
  createdByUserId!: string | null;

  @ApiPropertyOptional({ description: '结束人 userId', nullable: true })
  endedByUserId!: string | null;

  @ApiProperty({ description: '记录创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;

  @ApiPropertyOptional({
    description: '队员摘要(仅 GET /memberships 分页总表且 ?expand 含 member 时返回;默认省略)',
    type: () => MembershipExpandedMemberDto,
  })
  member?: MembershipExpandedMemberDto;

  @ApiPropertyOptional({
    description: '组织摘要(仅 GET /memberships 分页总表且 ?expand 含 organization 时返回;默认省略)',
    type: () => MembershipExpandedOrganizationDto,
  })
  organization?: MembershipExpandedOrganizationDto;
}

// ============ F4/D 组 入参:分页总表(GET /memberships) ============

export class PageMembershipsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按队员精确过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  memberId?: string;

  @ApiPropertyOptional({ description: '按组织节点精确过滤', maxLength: 64 })
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

  @ApiPropertyOptional({ description: '按归属类型过滤', enum: MembershipType })
  @IsOptional()
  @IsEnum(MembershipType)
  membershipType?: MembershipType;

  @ApiPropertyOptional({
    description: '按归属状态过滤(缺省 = 全部未软删,含 ENDED 历史)',
    enum: MembershipStatus,
  })
  @IsOptional()
  @IsEnum(MembershipStatus)
  status?: MembershipStatus;

  @ApiPropertyOptional({
    description: '模糊搜索(命中队员 memberNo+displayName + 组织 name+code;contains + insensitive)',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    description:
      'expand 展开(逗号分隔白名单:member,organization;缺省 = 不展开,响应形状与队员轴端点一致)',
    example: 'member,organization',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  expand?: string;
}

// ============ F4/D 组 入参:组织轴列表(GET /organizations/:orgId/memberships) ============

// F 批小修(2026-07-05):参数集对齐扁平总表 PageMembershipsQueryDto(155-182 行)—— +status/
// membershipType/q/expand 四项(organizationId 由路径段固定,不在此重复收)。**默认行为不变**:
// 缺省仍三态全返(ACTIVE/ENDED/SUSPENDED 混返),additive 红线,组织成员页请显式传 status=ACTIVE。
export class OrgMembershipsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '是否展开该组织全部后代组织(默认 false = 仅该节点直属)',
    default: false,
  })
  @IsOptional()
  @Transform(parseQueryBoolean)
  @IsBoolean()
  includeDescendants?: boolean;

  @ApiPropertyOptional({ description: '按归属类型过滤', enum: MembershipType })
  @IsOptional()
  @IsEnum(MembershipType)
  membershipType?: MembershipType;

  @ApiPropertyOptional({
    description:
      '按归属状态过滤(缺省 = 全部未软删,含 ENDED/SUSPENDED 历史;组织成员页只看现有人员请传 status=ACTIVE)',
    enum: MembershipStatus,
  })
  @IsOptional()
  @IsEnum(MembershipStatus)
  status?: MembershipStatus;

  @ApiPropertyOptional({
    description: '模糊搜索(命中队员 memberNo+displayName + 组织 name+code;contains + insensitive)',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    description:
      'expand 展开(逗号分隔白名单:member,organization;缺省 = 不展开,响应形状与队员轴端点一致)',
    example: 'member,organization',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  expand?: string;
}

// ============ F4/D 组 入参:冲突诊断(GET /memberships/conflicts) ============

export class MembershipConflictsQueryDto {
  @ApiPropertyOptional({ description: '限定组织节点(缺省 = 全库)', maxLength: 64 })
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
}

// ============ F4/D 组 出参:冲突诊断 ============

// 只读诊断分类(闭集;正常数据下 partial unique / FK Restrict 会挡住前两类,本端点是
// 历史/人工数据的体检面,不是判权或业务闸)。
export const MEMBERSHIP_CONFLICT_TYPES = [
  'multiple_active_primary', // 同一队员 >1 条 ACTIVE PRIMARY(理论上被 partial unique 挡,legacy 兜底)
  'dangling_member', // ACTIVE 归属指向已软删队员
  'dangling_organization', // ACTIVE 归属指向已软删组织
  'inactive_organization', // ACTIVE 归属指向 INACTIVE(停用)组织
] as const;
export type MembershipConflictType = (typeof MEMBERSHIP_CONFLICT_TYPES)[number];

export class MembershipConflictItemDto {
  @ApiProperty({ description: '冲突类型', enum: MEMBERSHIP_CONFLICT_TYPES })
  type!: MembershipConflictType;

  @ApiPropertyOptional({
    description: '涉事队员 id(multiple_active_primary / dangling_member 时有值)',
    nullable: true,
  })
  memberId!: string | null;

  @ApiPropertyOptional({
    description:
      '涉事组织 id(dangling_organization / inactive_organization 时有值;multiple_active_primary 跨组织为 null)',
    nullable: true,
  })
  organizationId!: string | null;

  @ApiProperty({ description: '涉事归属记录 id 列表', type: [String] })
  membershipIds!: string[];
}

export class MembershipConflictsResponseDto {
  @ApiProperty({ type: () => [MembershipConflictItemDto] })
  items!: MembershipConflictItemDto[];

  @ApiProperty({ description: '冲突条目总数(= items.length;零冲突即健康)' })
  total!: number;
}

// ============ F4/D 组 入参:组织轴队员下拉(GET /organizations/:orgId/members/options) ============

// 镜像 F1/A1 members/options 的 query 形状(organizationId 由路径段提供,不在 query 重复)。
export class OrgMembersOptionsQueryDto {
  @ApiPropertyOptional({
    description: '模糊搜索(跨字段命中 displayName + memberNo)',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    description: '是否展开该组织全部后代组织(默认 false = 仅该节点直属)',
    default: false,
  })
  @IsOptional()
  @Transform(parseQueryBoolean)
  @IsBoolean()
  includeDescendants?: boolean;

  @ApiPropertyOptional({ description: '结果条数上限(默认 20,上限 100)', minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

// ============ F4/D 组 入参:归属迁移(POST /memberships/transfer) ============

// 单事务「end 旧 + create 新」:把某队员的某类型归属从 orgA 迁到 orgB(受既有 partial unique 约束)。
// 严格白名单;源组织不要求存在/ACTIVE(迁出已软删/停用组织正是治理场景),目标组织须存在且 ACTIVE。
export class TransferMembershipDto {
  @ApiProperty({ description: '队员 id(须存在且 ACTIVE)', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  memberId!: string;

  @ApiProperty({
    description: '源组织节点 id(该队员须在此有对应类型的 ACTIVE 归属)',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64)
  fromOrganizationId!: string;

  @ApiProperty({
    description: '目标组织节点 id(须存在且 ACTIVE;不得与源相同)',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64)
  toOrganizationId!: string;

  @ApiProperty({
    description: '迁移的归属类型(源侧按此类型定位 ACTIVE 行;新行同类型)',
    enum: MembershipType,
    example: MembershipType.PRIMARY,
  })
  @IsEnum(MembershipType)
  membershipType!: MembershipType;

  @ApiPropertyOptional({ description: '迁移原因(写入新行 reason;自由短串,≤200)', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

// ============ 入参 ============

// POST /api/admin/v1/members/:memberId/memberships 入参。
// 严格白名单:**禁止** memberId(由路径参数提供)/ id / status / deletedAt / 时间戳 / *ByUserId。
export class CreateMembershipDto {
  @ApiProperty({
    description: '目标组织节点 id(必须存在且 status=ACTIVE)',
    example: 'cl9z3a8b00000abcd1234efgh',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64)
  organizationId!: string;

  @ApiProperty({
    description: '归属类型(指定;PRIMARY 至多一条 active,其余可并存多条)',
    enum: MembershipType,
    example: MembershipType.SECONDARY,
  })
  @IsEnum(MembershipType)
  membershipType!: MembershipType;

  @ApiPropertyOptional({ description: '编入原因(自由短串,≤200)', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

// PATCH /api/admin/v1/members/:memberId/memberships/:id 入参:改类型 / 任期 / 原因(全可选,至少一项)。
// 不改 status(结束走 DELETE);不改 memberId / organizationId(换组织 = 结束旧 + 新建)。
export class UpdateMembershipDto {
  @ApiPropertyOptional({ description: '归属类型', enum: MembershipType })
  @IsOptional()
  @IsEnum(MembershipType)
  membershipType?: MembershipType;

  @ApiPropertyOptional({ description: '任期起(ISO 8601)' })
  @IsOptional()
  @IsDateString()
  startedAt?: string;

  @ApiPropertyOptional({ description: '任期止(ISO 8601)' })
  @IsOptional()
  @IsDateString()
  endedAt?: string;

  @ApiPropertyOptional({ description: '原因(自由短串,≤200)', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
