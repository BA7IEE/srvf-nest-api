import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BindingScopeType, BindingStatus, PrincipalType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

// query boolean 从 GET query string 解析:原始值是字符串 'true'/'false',@Type(() => Boolean)
// 会用 `Boolean(value)` 转换 —— 任何非空字符串(含 'false')都会变 true,是已知陷阱,
// 故显式判等而非用 @Type(沿 F1/F2 members.dto.ts / activity-registrations.dto.ts 同名 helper 惯例,
// 本仓约定按 DTO 文件各自持有一份,不抽共享)。
const parseQueryBoolean = ({ value }: { value: unknown }): unknown =>
  value === true || value === 'true' ? true : value === false || value === 'false' ? false : value;

// 终态 scoped-authz PR6(2026-07-01;冻结稿 §3.6 / §7.5):带 scope 的角色绑定(role-bindings)CRUD + 查询 DTO 集合。
// 出参显式列字段(永不含 deletedAt);入参严格白名单(全局 ValidationPipe forbidNonWhitelisted 兜底)。
// **🔴 scoped 绑定入库即止,RbacService 只读 scopeType=GLOBAL、绝不判 scoped**(判权是 PR8 AuthzService)。
// principalId 多态无 FK;scopeType↔scope 字段一致性 / principalType↔principalId 一致性由 service 校验。

// ============ F3/C1 expand 展开子对象(路线图 §4 C1;D6 约定沿 F2 首落地形态)============

// 仅 `?expand=role` 命中时出现在响应里。独立 admin-surface class,不 extends / Pick / Omit(沿本仓隔离惯例)。
export class RoleBindingExpandedRoleDto {
  @ApiProperty({ description: '角色主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '角色 code(如 ops-admin / biz-admin)' })
  code!: string;

  @ApiProperty({ description: '角色显示名' })
  displayName!: string;
}

// 仅 `?expand=principal` 命中时出现在响应里。主体多态(USER / MEMBER / POSITION_ASSIGNMENT),
// 单 class 扁平可选字段承载三型(type 判别);SYSTEM 主体(principalId=null)无实体,principal 字段省略。
export class RoleBindingExpandedPrincipalDto {
  @ApiProperty({ description: '主体类型(回显绑定行 principalType)', enum: PrincipalType })
  type!: PrincipalType;

  @ApiProperty({ description: '主体实体 id(= 绑定行 principalId)' })
  id!: string;

  @ApiPropertyOptional({ description: 'type=USER 时:用户名' })
  username?: string;

  @ApiPropertyOptional({ description: 'type=USER 时:昵称(可空)', nullable: true })
  nickname?: string | null;

  @ApiPropertyOptional({ description: 'type=MEMBER 时:队员业务编号' })
  memberNo?: string;

  @ApiPropertyOptional({
    description: 'type=MEMBER / POSITION_ASSIGNMENT 时:队员显示名(任职主体取其背后队员)',
  })
  displayName?: string;

  @ApiPropertyOptional({ description: 'type=POSITION_ASSIGNMENT 时:任职组织 id' })
  organizationId?: string;

  @ApiPropertyOptional({ description: 'type=POSITION_ASSIGNMENT 时:职务 id' })
  positionId?: string;

  @ApiPropertyOptional({ description: 'type=POSITION_ASSIGNMENT 时:任职队员 id' })
  memberId?: string;
}

// ============ 出参:角色绑定记录 ============

// F3/C1(路线图 §4;D6 拍板):+可选 role / principal(仅 GET /role-bindings/page 且 expand 命中时
// 才出现;旧 4 端点从不设置这两个字段,默认响应形状逐字不变,additive)。
export class RoleBindingResponseDto {
  @ApiProperty({ description: '主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({
    description: '主体类型(USER / MEMBER / POSITION_ASSIGNMENT / SYSTEM)',
    enum: PrincipalType,
    example: PrincipalType.USER,
  })
  principalType!: PrincipalType;

  @ApiPropertyOptional({
    description: '主体 id(多态,随 principalType 指 user/member/position_assignment;SYSTEM 时可空)',
    nullable: true,
  })
  principalId!: string | null;

  @ApiProperty({ description: '角色外键(指向 roles.id)' })
  roleId!: string;

  @ApiProperty({
    description:
      'scope 类型(GLOBAL 全局 / ORGANIZATION 单组织 / ORGANIZATION_TREE 组织子树 / ACTIVITY 活动 / RESOURCE 资源 / SELF 本人)',
    enum: BindingScopeType,
    example: BindingScopeType.GLOBAL,
  })
  scopeType!: BindingScopeType;

  @ApiPropertyOptional({
    description: 'scope 组织 id(ORGANIZATION / ORGANIZATION_TREE 时有值)',
    nullable: true,
  })
  scopeOrgId!: string | null;

  @ApiPropertyOptional({ description: 'scope 活动 id(ACTIVITY 时有值)', nullable: true })
  scopeActivityId!: string | null;

  @ApiPropertyOptional({
    description: 'scope 资源类型(RESOURCE 时有值,如 attendance_sheet)',
    nullable: true,
  })
  scopeResourceType!: string | null;

  @ApiPropertyOptional({ description: 'scope 资源 id(RESOURCE 时有值)', nullable: true })
  scopeResourceId!: string | null;

  @ApiProperty({
    description: '绑定状态(ACTIVE 生效 / ENDED 已结束 / SUSPENDED 挂起)',
    enum: BindingStatus,
    example: BindingStatus.ACTIVE,
  })
  status!: BindingStatus;

  @ApiProperty({ description: '任期起' })
  startedAt!: Date;

  @ApiPropertyOptional({
    description: '任期止(为空表示无期限;过期不授权由 PR8 判)',
    nullable: true,
  })
  endedAt!: Date | null;

  @ApiPropertyOptional({ description: '创建人 userId', nullable: true })
  createdByUserId!: string | null;

  @ApiPropertyOptional({ description: '备注', nullable: true })
  note!: string | null;

  @ApiProperty({ description: '记录创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;

  @ApiPropertyOptional({
    description: '角色摘要(仅 GET /role-bindings/page 且 ?expand 含 role 时返回;默认省略)',
    type: () => RoleBindingExpandedRoleDto,
  })
  role?: RoleBindingExpandedRoleDto;

  @ApiPropertyOptional({
    description:
      '主体摘要(仅 GET /role-bindings/page 且 ?expand 含 principal 时返回;SYSTEM 主体恒省略;默认省略)',
    type: () => RoleBindingExpandedPrincipalDto,
  })
  principal?: RoleBindingExpandedPrincipalDto;
}

// ============ 入参:列出角色绑定(GET /role-bindings)过滤 ============

// 全部可空过滤条件(principalType × principalId × role × scopeType × status);默认返回全部未软删绑定。
export class ListRoleBindingsQueryDto {
  @ApiPropertyOptional({ description: '按主体类型过滤', enum: PrincipalType })
  @IsOptional()
  @IsEnum(PrincipalType)
  principalType?: PrincipalType;

  @ApiPropertyOptional({ description: '按主体 id 过滤', minLength: 1, maxLength: 64 })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  principalId?: string;

  @ApiPropertyOptional({ description: '按角色 id 过滤', minLength: 8, maxLength: 64 })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  roleId?: string;

  @ApiPropertyOptional({ description: '按 scope 类型过滤', enum: BindingScopeType })
  @IsOptional()
  @IsEnum(BindingScopeType)
  scopeType?: BindingScopeType;

  @ApiPropertyOptional({ description: '按绑定状态过滤', enum: BindingStatus })
  @IsOptional()
  @IsEnum(BindingStatus)
  status?: BindingStatus;
}

// ============ 入参:建角色绑定(POST /role-bindings) ============

// 严格白名单:**禁止** id / createdByUserId / 时间戳(除任期)/ deletedAt。
// scope 字段与 scopeType 的一致性、principalId 与 principalType 的一致性、被引用实体存在性均由 service 校验。
export class CreateRoleBindingDto {
  @ApiProperty({
    description: '主体类型(USER / MEMBER / POSITION_ASSIGNMENT / SYSTEM)',
    enum: PrincipalType,
    example: PrincipalType.USER,
  })
  @IsEnum(PrincipalType)
  principalType!: PrincipalType;

  @ApiPropertyOptional({
    description: '主体 id(非 SYSTEM 必填;多态,随 principalType 指 user/member/position_assignment)',
    minLength: 1,
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  principalId?: string;

  @ApiProperty({ description: '角色 id(RbacRole.id;须存在且未软删)', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  roleId!: string;

  @ApiProperty({
    description:
      'scope 类型(GLOBAL / ORGANIZATION / ORGANIZATION_TREE / ACTIVITY / RESOURCE / SELF)',
    enum: BindingScopeType,
    example: BindingScopeType.GLOBAL,
  })
  @IsEnum(BindingScopeType)
  scopeType!: BindingScopeType;

  @ApiPropertyOptional({
    description: 'scope 组织 id(ORGANIZATION / ORGANIZATION_TREE 必填,须存在)',
    minLength: 8,
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  scopeOrgId?: string;

  @ApiPropertyOptional({
    description: 'scope 活动 id(ACTIVITY 必填,须存在)',
    minLength: 8,
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  scopeActivityId?: string;

  @ApiPropertyOptional({
    description: 'scope 资源类型(RESOURCE 必填,如 attendance_sheet)',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  scopeResourceType?: string;

  @ApiPropertyOptional({ description: 'scope 资源 id(RESOURCE 必填)', minLength: 1, maxLength: 64 })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  scopeResourceId?: string;

  @ApiPropertyOptional({
    description: '任期起(ISO 8601;可空,默认建立时刻)',
    example: '2026-07-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  startedAt?: string;

  @ApiPropertyOptional({
    description: '任期止(ISO 8601;可空;有值须晚于任期起;过期不授权由 PR8 判)',
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

// ============ F3/C1 入参:分页列表(GET /role-bindings/page;D9 拍板) ============

// expand 白名单(D6 约定;parseExpandQuery 消费)。
export const ROLE_BINDING_EXPAND_TOKENS = ['role', 'principal'] as const;
export type RoleBindingExpandToken = (typeof ROLE_BINDING_EXPAND_TOKENS)[number];

// 旧 GET /role-bindings(bare 数组)逐字不动;本 DTO 只服务新 /page 兄弟路由(D9)。
// 过滤 = 既有 5 项(principalType × principalId × roleId × scopeType × status)+ 新 6 项。
export class PageRoleBindingsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按主体类型过滤', enum: PrincipalType })
  @IsOptional()
  @IsEnum(PrincipalType)
  principalType?: PrincipalType;

  @ApiPropertyOptional({ description: '按主体 id 过滤', minLength: 1, maxLength: 64 })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  principalId?: string;

  @ApiPropertyOptional({ description: '按角色 id 过滤', minLength: 8, maxLength: 64 })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  roleId?: string;

  @ApiPropertyOptional({ description: '按 scope 类型过滤', enum: BindingScopeType })
  @IsOptional()
  @IsEnum(BindingScopeType)
  scopeType?: BindingScopeType;

  @ApiPropertyOptional({
    description:
      '按绑定状态过滤(显式传本参数时优先于 includeExpired 的默认收窄 —— 如需查 ENDED/SUSPENDED 直接传本参数)',
    enum: BindingStatus,
  })
  @IsOptional()
  @IsEnum(BindingStatus)
  status?: BindingStatus;

  @ApiPropertyOptional({ description: '按 scope 组织 id 精确过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  scopeOrgId?: string;

  @ApiPropertyOptional({ description: '按角色 code 精确过滤(如 ops-admin)', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  roleCode?: string;

  @ApiPropertyOptional({
    description:
      '主体模糊搜索(USER 命中 username+nickname;MEMBER 命中 memberNo+displayName;' +
      'POSITION_ASSIGNMENT 命中其背后队员的 memberNo+displayName;contains + insensitive)',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  principalQ?: string;

  @ApiPropertyOptional({
    description:
      '是否包含已失效绑定(默认 false = 仅「当前生效」:status=ACTIVE 且未过任期;' +
      'true 返回全部未软删绑定。显式传 status 参数时本参数的默认收窄不生效)',
    default: false,
  })
  @IsOptional()
  @Transform(parseQueryBoolean)
  @IsBoolean()
  includeExpired?: boolean;

  @ApiPropertyOptional({
    description: '模糊搜索(命中 note + 角色 code + 角色显示名;contains + insensitive)',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({
    description: 'expand 展开(逗号分隔白名单:role,principal;缺省 = 不展开,响应形状与旧端点一致)',
    example: 'role,principal',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  expand?: string;
}

// ============ F3/C1 入参:dry-run 预检(GET /role-bindings/preview) ============

// 与 create 同参(query 形态;路线图 §4 C1「入与 create 同参」)。只校验不写库;
// note 一并接受(与 create 参数集对齐)但不影响校验结论。
export class PreviewRoleBindingQueryDto {
  @ApiProperty({
    description: '主体类型(USER / MEMBER / POSITION_ASSIGNMENT / SYSTEM)',
    enum: PrincipalType,
    example: PrincipalType.USER,
  })
  @IsEnum(PrincipalType)
  principalType!: PrincipalType;

  @ApiPropertyOptional({
    description: '主体 id(非 SYSTEM 必填;多态,随 principalType 指 user/member/position_assignment)',
    minLength: 1,
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  principalId?: string;

  @ApiProperty({ description: '角色 id(RbacRole.id)', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  roleId!: string;

  @ApiProperty({
    description:
      'scope 类型(GLOBAL / ORGANIZATION / ORGANIZATION_TREE / ACTIVITY / RESOURCE / SELF)',
    enum: BindingScopeType,
    example: BindingScopeType.GLOBAL,
  })
  @IsEnum(BindingScopeType)
  scopeType!: BindingScopeType;

  @ApiPropertyOptional({
    description: 'scope 组织 id(ORGANIZATION / ORGANIZATION_TREE 必填)',
    minLength: 8,
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  scopeOrgId?: string;

  @ApiPropertyOptional({ description: 'scope 活动 id(ACTIVITY 必填)', minLength: 8, maxLength: 64 })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  scopeActivityId?: string;

  @ApiPropertyOptional({ description: 'scope 资源类型(RESOURCE 必填)', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  scopeResourceType?: string;

  @ApiPropertyOptional({ description: 'scope 资源 id(RESOURCE 必填)', minLength: 1, maxLength: 64 })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  scopeResourceId?: string;

  @ApiPropertyOptional({ description: '任期起(ISO 8601;可空,默认预检时刻)' })
  @IsOptional()
  @IsDateString()
  startedAt?: string;

  @ApiPropertyOptional({ description: '任期止(ISO 8601;可空;有值须晚于任期起)' })
  @IsOptional()
  @IsDateString()
  endedAt?: string;

  @ApiPropertyOptional({ description: '备注(与 create 参数集对齐;不参与校验)', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

// ============ F3/C1 出参:dry-run 预检结果 ============

export class RoleBindingPreviewConflictDto {
  @ApiPropertyOptional({
    description: '底层 BizCode(如 34003 scope 形状非法 / 34002 已存在同维度 ACTIVE 绑定)',
    nullable: true,
  })
  bizCode!: number | null;

  @ApiProperty({ description: '人类可读说明(取自被复用校验抛出的 BizException.message)' })
  message!: string;
}

export class RoleBindingResolvedScopeDto {
  @ApiProperty({ description: 'scope 类型(入参回显)', enum: BindingScopeType })
  scopeType!: BindingScopeType;

  @ApiPropertyOptional({ description: 'scope 组织 id(归一化;未提供为 null)', nullable: true })
  scopeOrgId!: string | null;

  @ApiPropertyOptional({ description: 'scope 活动 id(归一化)', nullable: true })
  scopeActivityId!: string | null;

  @ApiPropertyOptional({ description: 'scope 资源类型(归一化)', nullable: true })
  scopeResourceType!: string | null;

  @ApiPropertyOptional({ description: 'scope 资源 id(归一化)', nullable: true })
  scopeResourceId!: string | null;
}

export class RoleBindingPreviewResponseDto {
  @ApiProperty({ description: '是否可建(conflicts 为空即 true;dry-run 结论,零写入)' })
  valid!: boolean;

  @ApiProperty({
    description: '冲突/非法原因列表(与 create 同一套校验逐项收集;valid=true 时为空数组)',
    type: () => [RoleBindingPreviewConflictDto],
  })
  conflicts!: RoleBindingPreviewConflictDto[];

  @ApiProperty({
    description: '归一化后的 scope(缺省 scope 字段落 null;供前端回显确认)',
    type: () => RoleBindingResolvedScopeDto,
  })
  resolvedScope!: RoleBindingResolvedScopeDto;
}

// ============ F3/C1 入参:批量建绑定(POST /role-bindings/batch) ============

export class BatchCreateRoleBindingsDto {
  @ApiProperty({
    description:
      '待建绑定列表(≤200;逐条独立处理,单条失败不影响其它条;镜像 announcement-import 幂等)',
    type: () => [CreateRoleBindingDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => CreateRoleBindingDto)
  items!: CreateRoleBindingDto[];
}

// ============ F3/C1 出参:批量建绑定逐条结果(deny/blocked 是数据,沿 announcement-import 范式) ============

export const ROLE_BINDING_BATCH_OUTCOME_VALUES = ['ok', 'blocked', 'already-exists'] as const;
export type RoleBindingBatchOutcome = (typeof ROLE_BINDING_BATCH_OUTCOME_VALUES)[number];

export class RoleBindingBatchItemResultDto {
  @ApiProperty({ description: '对应入参 items 下标(0 起)' })
  index!: number;

  @ApiProperty({
    description:
      '逐条结果:ok=已建 / already-exists=同维度 ACTIVE 绑定已存在(幂等 skip)/ blocked=校验失败',
    enum: ROLE_BINDING_BATCH_OUTCOME_VALUES,
  })
  outcome!: RoleBindingBatchOutcome;

  @ApiPropertyOptional({ description: 'outcome=ok 时:新建绑定 id', nullable: true })
  bindingId!: string | null;

  @ApiPropertyOptional({
    description: 'outcome=blocked/already-exists 时:底层 BizCode(ok 为 null)',
    nullable: true,
  })
  bizCode!: number | null;

  @ApiPropertyOptional({ description: '人类可读说明(ok 为 null)', nullable: true })
  message!: string | null;
}

export class RoleBindingBatchSummaryDto {
  @ApiProperty({ description: '本次请求总条数' })
  total!: number;

  @ApiProperty() ok!: number;
  @ApiProperty() blocked!: number;
  @ApiProperty({ description: "outcome='already-exists' 条数(幂等 skip)" })
  alreadyExists!: number;
}

export class BatchCreateRoleBindingsResponseDto {
  @ApiProperty({ type: () => [RoleBindingBatchItemResultDto] })
  items!: RoleBindingBatchItemResultDto[];

  @ApiProperty({ type: () => RoleBindingBatchSummaryDto })
  summary!: RoleBindingBatchSummaryDto;
}

// ============ 入参:改角色绑定(PATCH /role-bindings/:id) ============

// 只改状态 / 任期 / note;**不可改** principalType / principalId / roleId / scope(绑定身份不变,换绑定=软删旧建新)。
export class UpdateRoleBindingDto {
  @ApiPropertyOptional({
    description: '绑定状态(ACTIVE 生效 / ENDED 已结束 / SUSPENDED 挂起)',
    enum: BindingStatus,
  })
  @IsOptional()
  @IsEnum(BindingStatus)
  status?: BindingStatus;

  @ApiPropertyOptional({ description: '任期起(ISO 8601)', example: '2026-07-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  startedAt?: string;

  @ApiPropertyOptional({
    description: '任期止(ISO 8601;有值须晚于任期起)',
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
