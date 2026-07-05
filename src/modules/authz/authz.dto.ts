import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BindingScopeType, Role, UserStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type { AuthzReason, GrantSource, ResourceSensitivityLevel } from './authz.types';
import type { ActionStateReason } from './action-state-checks';

// 终态 scoped-authz PR10「authz/explain 端点」(2026-07-02;冻结稿 §7.6 + §9 行 20):
// 权限解释端点 DTO。响应侧逐字段镜像 authz.types 的 AuthzDecision / MatchedGrant / ResolvedResource
// (只声明 Swagger 形状,不复制逻辑);请求侧做严格白名单校验 —— 入参非法走通用 400(goal 决断②,
// 不新增 BizCode;与 permissions.dto「格式校验留 service 抛 30008」刻意不同:explain 是诊断读,
// 格式错误没有业务语义,不值一个专用码)。

// ============ 运行时枚举数组(Swagger enum + 校验白名单)============

// resourceRef.type 白名单 = ResourceResolverService.resolve() switch 的 11 类(冻结稿 §5.1),
// 顺序与 resolver 分发一致。未来 resolver 扩类时须同步本表(漏加只会 400 拒收,fail-safe 收紧方向,
// 不会误放行);消费面迁移(PR12)扩类时随刀更新。
export const EXPLAINABLE_RESOURCE_TYPES = [
  'activity',
  'attendance_sheet',
  'attendance_record',
  'activity_registration',
  'member',
  'member_profile',
  'certificate',
  'team_join_application',
  'recruitment_application',
  'notification',
  'attachment',
] as const;

// reason 全集 = authz.types AuthzReason 联合(2 allow + 9 deny;§5.2 / §9 行 20 契约锁)。
// `satisfies` 保证不出现联合外的值;完备性(不缺值)由 authz-explain e2e 的 Record<AuthzReason, true>
// 覆盖锁双向兜底 —— 任一方向漂移,编译或 e2e 立即红。
export const AUTHZ_REASON_VALUES = [
  'super_admin_pass',
  'matched',
  'no_permission',
  'out_of_scope',
  'out_of_supervised_scope',
  'expired_grant',
  'inactive_org',
  'self_approval_forbidden',
  'same_reviewer_forbidden',
  'sensitive_denied',
  'resource_not_found',
] as const satisfies readonly AuthzReason[];

export const GRANT_SOURCE_VALUES = [
  'super_admin',
  'role_binding',
  'position',
  'supervision',
] as const satisfies readonly GrantSource[];

const SENSITIVITY_LEVEL_VALUES = [
  'public',
  'internal',
  'sensitive',
] as const satisfies readonly ResourceSensitivityLevel[];

// action 格式沿 permission code 正则口径(D2 v1.2,permissions.service.ts 同源):
// kebab-case 3-4 段;**不要求码存在** —— 不存在的码 explain 返 no_permission 本身就是诊断价值。
const ACTION_CODE_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,3}$/;

// ============ 请求 ============

export class ExplainResourceRefDto {
  @ApiProperty({
    description: '资源类型(ResourceResolver 支持的 11 类;冻结稿 §5.1)',
    enum: EXPLAINABLE_RESOURCE_TYPES,
    example: 'attendance_sheet',
  })
  @IsIn(EXPLAINABLE_RESOURCE_TYPES)
  type!: string;

  @ApiProperty({ description: '资源主键 id' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  id!: string;
}

export class ExplainAuthzDto {
  @ApiProperty({ description: '目标用户 id(被解释判权的人,非调用者);不存在/已软删 → 10001' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  userId!: string;

  @ApiProperty({
    description:
      'action 权限码,格式 <module>.<action>.<resource_type>[.<scope>](D2 v1.2 正则口径;' +
      '不要求码存在 —— 不存在的码返 no_permission 即诊断结论)',
    example: 'attendance.final-approve.sheet',
  })
  @IsString()
  @MinLength(5)
  @MaxLength(80)
  @Matches(ACTION_CODE_PATTERN, {
    message:
      'action 必须为 kebab-case 3-4 段权限码形态(<module>.<action>.<resource_type>[.<scope>])',
  })
  action!: string;

  @ApiPropertyOptional({
    description: '可选资源引用;缺省 = 无 ref 退化路径(等价 rbac.can 全局判定)',
    type: ExplainResourceRefDto,
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ExplainResourceRefDto)
  resourceRef?: ExplainResourceRefDto;
}

// ============ 响应(镜像 authz.types,contract snapshot 锁形状)============

export class ExplainTargetUserDto {
  @ApiProperty({ description: '目标用户 id' })
  id!: string;

  @ApiProperty({ description: '用户名' })
  username!: string;

  @ApiProperty({ description: '内置角色', enum: Role, example: Role.USER })
  role!: Role;

  @ApiProperty({
    description:
      '账号状态(原样返;DISABLED 用户也可 explain —— 线上真实请求会先被 JwtStrategy 挡,此字段让运营看清这一层)',
    enum: UserStatus,
    example: UserStatus.ACTIVE,
  })
  status!: UserStatus;

  @ApiPropertyOptional({ description: '绑定的 member id(未绑定为 null)', nullable: true })
  memberId!: string | null;
}

export class MatchedGrantDto {
  @ApiProperty({
    description:
      '授权来源:super_admin 短路 / role_binding 直接绑定(3a)/ position 职务推导(3b)/ supervision 分管推导(3c)',
    enum: GRANT_SOURCE_VALUES,
  })
  source!: GrantSource;

  @ApiPropertyOptional({
    description: 'source=role_binding 时的绑定行 id(内部 id 原样返,ops-admin 面可见)',
  })
  bindingId?: string;

  @ApiPropertyOptional({ description: 'source=position 时的任职 id' })
  positionAssignmentId?: string;

  @ApiPropertyOptional({ description: 'source=supervision 时的分管 id' })
  supervisionAssignmentId?: string;

  @ApiPropertyOptional({ description: '命中角色 code(super_admin 短路时缺省)' })
  roleCode?: string;

  @ApiProperty({ description: '命中授权的 scope 类型', enum: BindingScopeType })
  scopeType!: BindingScopeType;

  @ApiPropertyOptional({
    description: 'scope 主键(按 scopeType 取 org / activity / resource id;GLOBAL 缺省)',
  })
  scopeId?: string;
}

export class ResolvedResourceDto {
  @ApiProperty({ description: '资源类型(入参 type 回显)' })
  resourceType!: string;

  @ApiProperty({ description: '资源主键 id' })
  resourceId!: string;

  @ApiPropertyOptional({ description: '资源归属组织 id(无组织归属恒 null)', nullable: true })
  organizationId!: string | null;

  @ApiPropertyOptional({
    description: '归属组织祖先链(closure 反查,root 在前、含自身;可解释性用)',
    nullable: true,
    type: [String],
  })
  organizationPath!: string[] | null;

  @ApiPropertyOptional({ description: '资源属主 member id', nullable: true })
  ownerMemberId!: string | null;

  @ApiPropertyOptional({ description: '资源属主 user id', nullable: true })
  ownerUserId!: string | null;

  @ApiPropertyOptional({ description: '关联活动 id(activity scope 判定)', nullable: true })
  activityId!: string | null;

  @ApiPropertyOptional({ description: '业务状态码(展示用,不参与 scope 判定)', nullable: true })
  statusCode!: string | null;

  @ApiPropertyOptional({
    description: '敏感分级 hint(权限码粒度仍是权威,§4.2)',
    nullable: true,
    enum: SENSITIVITY_LEVEL_VALUES,
  })
  sensitivityLevel!: ResourceSensitivityLevel | null;

  @ApiPropertyOptional({
    description: '域特定附加(如 attendance_sheet 的 submitterUserId / reviewerUserId,自审约束事实)',
    type: 'object',
    additionalProperties: true,
  })
  extra?: Record<string, unknown>;
}

export class AuthzDecisionDto {
  @ApiProperty({ description: '是否允许(deny 是数据不是错误 —— 入参合法即 200 返 decision)' })
  allow!: boolean;

  @ApiProperty({
    description:
      '决断原因(稳定枚举,§9 行 20 契约锁):allow ∈ {super_admin_pass, matched};其余为 deny 归因,' +
      'resource_not_found 亦是 200 的 decision reason(诊断端点回答"为什么",不抛业务错)',
    enum: AUTHZ_REASON_VALUES,
  })
  reason!: AuthzReason;

  @ApiPropertyOptional({
    description: '命中授权(allow 时必有 —— 每个 allow 必能指出命中的授权行;deny 时缺省)',
    type: MatchedGrantDto,
  })
  matchedGrant?: MatchedGrantDto;

  @ApiPropertyOptional({
    description: '解析后的资源归属(有 ref 且解析成功时返;resource_not_found / 无 ref 时缺省)',
    type: ResolvedResourceDto,
  })
  resource?: ResolvedResourceDto;
}

export class ExplainAuthzResponseDto {
  @ApiProperty({
    description: '目标用户快照(id / username / role / status / memberId)',
    type: ExplainTargetUserDto,
  })
  targetUser!: ExplainTargetUserDto;

  @ApiProperty({
    description:
      '判权决断(PR8 AuthzService.explain 原样输出:allow + reason + matchedGrant? + resource?)',
    type: AuthzDecisionDto,
  })
  decision!: AuthzDecisionDto;
}

// ============ F3/C2 批量权限解释(POST /authz/explain-batch;路线图 §4 C2 / D8)============

// 单条 explain 的批量壳:逐条镜像 ExplainAuthzDto 字段与校验;≤200。
// **同一套 AuthzReason 11 值枚举**(不扩值);deny 仍是 200 数据。
// 输入错误语义镜像单条:任一 userId 不存在/已软删 → 整请求 10001(items 内无「用户不存在」通道 —— reason 枚举是契约锁)。
export class ExplainBatchItemDto {
  @ApiProperty({ description: '目标用户 id(被解释判权的人,非调用者)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  userId!: string;

  @ApiProperty({
    description: 'action 权限码(D2 v1.2 正则口径;不要求码存在,同单条 explain)',
    example: 'attendance.final-approve.sheet',
  })
  @IsString()
  @MinLength(5)
  @MaxLength(80)
  @Matches(ACTION_CODE_PATTERN, {
    message:
      'action 必须为 kebab-case 3-4 段权限码形态(<module>.<action>.<resource_type>[.<scope>])',
  })
  action!: string;

  @ApiPropertyOptional({
    description: '可选资源引用;缺省 = 无 ref 退化路径(等价 rbac.can 全局判定)',
    type: ExplainResourceRefDto,
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ExplainResourceRefDto)
  resourceRef?: ExplainResourceRefDto;
}

export class ExplainAuthzBatchDto {
  @ApiProperty({
    description: '待解释项列表(≤200;逐条独立判定,decision 互不影响)',
    type: () => [ExplainBatchItemDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ExplainBatchItemDto)
  items!: ExplainBatchItemDto[];
}

export class ExplainBatchResultItemDto {
  @ApiProperty({ description: '目标用户 id(入参回显)' })
  userId!: string;

  @ApiProperty({ description: 'action 权限码(入参回显)' })
  action!: string;

  @ApiPropertyOptional({
    description: '资源引用(入参回显;未传则缺省)',
    type: ExplainResourceRefDto,
  })
  resourceRef?: ExplainResourceRefDto;

  @ApiProperty({
    description: '判权决断(同单条 explain:reason 同一套 11 值稳定枚举;deny 是 200 数据)',
    type: AuthzDecisionDto,
  })
  decision!: AuthzDecisionDto;
}

export class ExplainAuthzBatchResponseDto {
  @ApiProperty({ type: () => [ExplainBatchResultItemDto] })
  items!: ExplainBatchResultItemDto[];
}

// ============ F3/C3 批量业务态闸(POST /authz/action-state/batch;路线图 §4 C3 / D8)============

// reason 全集 = AuthzReason 11 值 ∪ 'state_forbidden'(状态机只读否决;前端友好新枚举值,入 OpenAPI 契约)。
// 完备性由 authz-action-state e2e 的 Record 覆盖锁双向兜底(镜像 AUTHZ_REASON_VALUES 范式)。
export const ACTION_STATE_REASON_VALUES = [
  ...AUTHZ_REASON_VALUES,
  'state_forbidden',
] as const satisfies readonly ActionStateReason[];

export class ActionStateItemDto {
  @ApiProperty({
    description: 'action 权限码(判权 + 已注册项叠加状态机只读校验)',
    example: 'attendance.final-approve.sheet',
  })
  @IsString()
  @MinLength(5)
  @MaxLength(80)
  @Matches(ACTION_CODE_PATTERN, {
    message:
      'action 必须为 kebab-case 3-4 段权限码形态(<module>.<action>.<resource_type>[.<scope>])',
  })
  action!: string;

  @ApiProperty({
    description: '资源类型(ResourceResolver 支持的 11 类;同 explain 白名单)',
    enum: EXPLAINABLE_RESOURCE_TYPES,
    example: 'attendance_sheet',
  })
  @IsIn(EXPLAINABLE_RESOURCE_TYPES)
  resourceType!: string;

  @ApiProperty({ description: '资源主键 id' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  resourceId!: string;

  @ApiPropertyOptional({
    description:
      '调用方自定义关联键(可选,原样透传回显;不参与判权/去重/入库,仅做长度约束 —— 是否重复由调用方自行处理;' +
      '供前端跨区域合并请求或缓存合并场景做第二自然键,三处收尾 2026-07-05 additive)',
    maxLength: 64,
    example: 'sheet-row-42',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  key?: string;
}

export class ActionStateBatchDto {
  @ApiProperty({
    description: '待判定项列表(≤200;判定对象 = 调用者本人 ——「这组按钮对我该不该亮」)',
    type: () => [ActionStateItemDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ActionStateItemDto)
  items!: ActionStateItemDto[];
}

export class ActionStateResultItemDto {
  @ApiProperty({ description: 'action 权限码(入参回显)' })
  action!: string;

  @ApiProperty({
    description: '资源类型(入参回显;F 批小修 2026-07-05 additive,对齐 explain-batch 全回显口径)',
    enum: EXPLAINABLE_RESOURCE_TYPES,
    example: 'attendance_sheet',
  })
  resourceType!: string;

  @ApiProperty({ description: '资源主键 id(入参回显)' })
  resourceId!: string;

  @ApiPropertyOptional({
    description:
      '调用方自定义关联键(入参回显;仅当该 item 的请求携带 `key` 时才出现在响应里,缺省该字段不存在 —— ' +
      'additive,三处收尾 2026-07-05)',
    maxLength: 64,
    example: 'sheet-row-42',
  })
  key?: string;

  @ApiProperty({
    description: '是否可执行(= authz 判权 ∧ 已注册项的状态机只读校验;deny 是 200 数据)',
  })
  allowed!: boolean;

  @ApiProperty({
    description:
      '判定原因:authz 11 值稳定枚举 ∪ state_forbidden(判权放行但资源当前状态不允许该动作);' +
      'allowed=true 时为 super_admin_pass / matched',
    enum: ACTION_STATE_REASON_VALUES,
  })
  reason!: ActionStateReason;
}

export class ActionStateBatchResponseDto {
  @ApiProperty({
    description: 'items 顺序 = 请求 items 顺序(逐条一一对应,按下标回填按钮状态)',
    type: () => [ActionStateResultItemDto],
  })
  items!: ActionStateResultItemDto[];
}
