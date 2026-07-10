import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MemberStatus, Role, UserStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { MAINLAND_PHONE_PATTERN } from '../sms/sms.constants';

// query boolean 从 GET query string 解析:原始值是字符串 'true'/'false',@Type(() => Boolean)
// 会用 `Boolean(value)` 转换 —— 任何非空字符串(含 'false')都会变 true,是已知陷阱,
// 故显式判等而非用 @Type。
const parseQueryBoolean = ({ value }: { value: unknown }): unknown =>
  value === true || value === 'true' ? true : value === false || value === 'false' ? false : value;

// V2 第一阶段 members 模块 DTO 集合。
// 出参显式列字段(永不含 deletedAt 软删内部状态);入参严格白名单 + class-validator,
// 配合 forbidNonWhitelisted 兜底。详见 docs/v2-api-contract.md §4 / docs/v2-data-model.md §5。
//
// **绝对禁止任何敏感字段**:身份证 / 紧急联系人 / 医疗 / 出生日期 / 住址 / 性别 /
// 联系方式 / 第三方账号 / 凭证(全部延后到 V2.x member_profiles)。
// **绝对禁止改 memberNo**:UpdateMemberDto 不含 memberNo 字段(memberNo 是稳定身份标识)。

// ============ 出参 ============

export class MemberResponseDto {
  @ApiProperty({
    description: '主键(cuid;独立,不复用 users.id)',
    example: 'cl9z3a8b00000abcd1234efgh',
  })
  id!: string;

  @ApiProperty({
    description: '队员业务唯一编号(全局唯一,包含软删不复用;非敏感、高价值业务标识)',
    example: 'M-0001',
  })
  memberNo!: string;

  @ApiProperty({ description: '称呼 / 显示名(业务可读)', example: 'Demo Member' })
  displayName!: string;

  @ApiPropertyOptional({
    description: '等级字典 code(隐含 type code = member_grade)',
    nullable: true,
  })
  gradeCode!: string | null;

  @ApiProperty({ description: '在队 / 离队状态', enum: MemberStatus })
  status!: MemberStatus;

  @ApiProperty({
    description:
      '是否已开通登录账号(队员账号闭环 v1;存在关联 User 即 true,含已禁用/软删的绑定 —— 不代表当前可登录,仅表示该 memberId 槽位已被占用)',
  })
  hasAccount!: boolean;

  @ApiPropertyOptional({
    description: '关联账号状态(无关联为 null;队员账号闭环 v1)',
    enum: UserStatus,
    nullable: true,
  })
  accountStatus!: UserStatus | null;

  @ApiPropertyOptional({
    description: '关联账号 id(无关联为 null;队员账号闭环 v1)',
    nullable: true,
  })
  userId!: string | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// 参与域生命周期收口⑤(v0.40.0):一键离队编排响应。四腿实际发生计数 + 残留 active 任职/分管
// (advisory 只读,提醒管理员另走独立撤销端点;offboard 刻意不级联任职/分管/role-bindings)。
export class MemberOffboardResponseDto {
  @ApiProperty({
    description: '离队后队员档案(status=INACTIVE;含账号信息)',
    type: MemberResponseDto,
  })
  member!: MemberResponseDto;

  @ApiProperty({ description: '本次是否将队员从 ACTIVE 置为 INACTIVE(已 INACTIVE 则 false)' })
  memberDeactivated!: boolean;

  @ApiProperty({ description: '本次结束(ENDED)的 active 归属条数(全类型;无 active 则 0)' })
  membershipsEnded!: number;

  @ApiProperty({ description: '本次是否停用了关联登录账号(无 linked / 已 DISABLED 则 false)' })
  accountDisabled!: boolean;

  @ApiProperty({ description: '本次撤销的未过期 refresh token 条数' })
  refreshTokensRevoked!: number;

  @ApiPropertyOptional({ description: '关联账号 id(无关联为 null)', nullable: true })
  linkedUserId!: string | null;

  @ApiProperty({
    description: '残留 active 任职数(advisory;offboard 不级联撤职,须另走任职撤销端点)',
  })
  residualActivePositionAssignments!: number;

  @ApiProperty({
    description: '残留 active 分管数(advisory;offboard 不级联撤分管,须另走分管撤销端点)',
  })
  residualActiveSupervisions!: number;
}

// ============ 入参 ============

// memberNo 校验:DTO 层 @MinLength(1) + @MaxLength(32) + 字符集 [A-Za-z0-9-];
// service 层 trim() 保留原大小写(与 v1 username 的 toLowerCase() 不同 — 编号即身份)。
export class CreateMemberDto {
  @ApiProperty({
    description:
      'memberNo 业务唯一编号(必填;trim 后保存,保留大小写;字母 / 数字 / 连字符;长度 1-32)',
    example: 'M-0001',
    minLength: 1,
    maxLength: 32,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  @Matches(/^[A-Za-z0-9-]+$/, {
    message: 'memberNo 只允许字母 / 数字 / 连字符',
  })
  memberNo!: string;

  @ApiProperty({ description: '称呼 / 显示名', maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  displayName!: string;

  @ApiPropertyOptional({
    description: '等级字典 code(可选;若提供必须在 type=member_grade 字典中存在且 ACTIVE)',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  gradeCode?: string;
}

// 仅允许 displayName / gradeCode;**绝对禁止**:
// - memberNo(稳定身份标识,本期不开发改编号接口)
// - status(走 PATCH /:id/status)
// - id / deletedAt
// - 任何敏感字段(由 forbidNonWhitelisted 兜底拒绝)
export class UpdateMemberDto {
  @ApiPropertyOptional({ description: '称呼 / 显示名', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  displayName?: string;

  @ApiPropertyOptional({ description: '等级字典 code', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  gradeCode?: string;
}

export class UpdateMemberStatusDto {
  @ApiProperty({
    description: '目标状态(ACTIVE / INACTIVE)',
    enum: MemberStatus,
    example: MemberStatus.INACTIVE,
  })
  @IsEnum(MemberStatus)
  status!: MemberStatus;
}

// 列表 query:支持 memberNo 精确查询(完整匹配,不做模糊 — 编号即身份)、
// gradeCode 过滤、status 过滤。
// F1/A1(路线图 §4;D1/D7 拍板):新增可选 q(模糊命中 displayName+memberNo)/
// organizationId(经 memberOrganizationMemberships 关联过滤)/ includeDescendants
// (配合 organizationId 展开后代组织,默认 false)。旧字段/响应形状不变(additive)。
export class ListMembersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'memberNo 精确查询(完整匹配)', maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  memberNo?: string;

  @ApiPropertyOptional({ description: 'gradeCode 过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  gradeCode?: string;

  @ApiPropertyOptional({ description: '按状态过滤', enum: MemberStatus })
  @IsOptional()
  @IsEnum(MemberStatus)
  status?: MemberStatus;

  @ApiPropertyOptional({
    description: '模糊搜索(跨字段命中 displayName + memberNo;contains + insensitive)',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    description: '按组织归属过滤(经 active membership 关联;任意 membershipType 均计入)',
    maxLength: 64,
  })
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

  @ApiPropertyOptional({
    description: '按是否已开通登录账号过滤(队员账号闭环 v1;不传 = 不过滤)',
  })
  @IsOptional()
  @Transform(parseQueryBoolean)
  @IsBoolean()
  hasAccount?: boolean;
}

// ============ F1/A1 选择器(路线图 §4;D2/D3 拍板)============

export class MemberOptionsQueryDto {
  @ApiPropertyOptional({
    description: '模糊搜索(跨字段命中 displayName + memberNo)',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ description: '按组织归属过滤(经 active membership 关联)', maxLength: 64 })
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

  @ApiPropertyOptional({ description: '结果条数上限(默认 20,上限 100)', minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class MemberOptionItemDto {
  @ApiProperty({ description: '主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '展示标签(= displayName)' })
  label!: string;

  @ApiProperty({ description: '队员业务唯一编号' })
  memberNo!: string;

  @ApiPropertyOptional({ description: '等级字典 code', nullable: true })
  gradeCode!: string | null;
}

export class MemberOptionsResponseDto {
  @ApiProperty({ description: '结果列表(不分页,受 limit 截断)', type: () => [MemberOptionItemDto] })
  items!: MemberOptionItemDto[];
}

// ============ 队员账号闭环 v1(MVP)：POST /:id/account ============

// 开号 = 建一个绑定手机号的 User(memberId 指向该队员、role=USER、username=memberNo、
// 随机不可用 passwordHash),队员用现有 login-sms 手机验证码登录;不设密码、不接收
// role / status / password 入参(v1 范围红线)。
export class GrantMemberAccountDto {
  @ApiProperty({
    description:
      '账号级手机号(必填;写入 User.phone,供 login-sms 登录;与 Member.phonePrimary 互不相干、不合并不同步)',
    example: '13800001234',
  })
  @IsString()
  @Matches(MAINLAND_PHONE_PATTERN, { message: 'phone 必须是大陆 11 位手机号' })
  phone!: string;
}

export class GrantMemberAccountResponseDto {
  @ApiProperty({ description: '新建账号 id(cuid)' })
  userId!: string;

  @ApiProperty({ description: '登录用户名(= memberNo,不做大小写归一化)', example: 'M-0001' })
  username!: string;

  @ApiProperty({ description: '账号级手机号(login-sms 登录用)', example: '13800001234' })
  phone!: string;

  @ApiProperty({ description: '手机号验证时间(管理员背书,非用户自证短信验证)' })
  phoneVerifiedAt!: Date;

  @ApiProperty({ description: '角色(恒 USER)', enum: Role, example: Role.USER })
  role!: Role;

  @ApiProperty({ description: '关联队员 id', example: 'cl9z3a8b00000abcd1234efgh' })
  memberId!: string;
}

// ============ 队员账号闭环 v2:POST /:id/account/bind ============

// 绑定 = 认领一个已存在、live 且未被任何队员绑定(memberId=null)的悬空账号
// (如 POST admin/v1/users 建的)到本队员;账号保留其原有登录方式(密码 / openid / phone),
// 不强制手机号、不改 username/passwordHash。
export class BindMemberAccountDto {
  @ApiProperty({
    description: '待绑定的既有账号 id(必须 live 且当前 memberId 为 null)',
    example: 'cl9z3a8b00000abcd1234efgh',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64, { message: 'userId 必须是 8-64 位字符串' })
  userId!: string;
}

// ============ 队员账号闭环 v2:PATCH /:id/account/status ============

// 队员面启停关联账号;判权复用 user.update.status(D-6),不新增权限码。
export class UpdateMemberAccountStatusDto {
  @ApiProperty({
    description: '目标账号状态(ACTIVE / DISABLED)',
    enum: UserStatus,
    example: UserStatus.DISABLED,
  })
  @IsEnum(UserStatus)
  status!: UserStatus;
}

// ============ 队员账号闭环 v2:POST members/accounts/bulk-grant ============

// 批量开号:镜像 announcement-import 批模式——逐行 skip-on-error(每行各自独立事务,
// 单行失败不影响其余行)+ 逐行结果回报,非全或无。判权复用 member.grant.account(0 新码);
// 逐行校验顺序与单条 grantAccount 完全一致(见 grantAccountCore)。

const BULK_GRANT_MAX_ITEMS = 200;

export class BulkGrantAccountItemDto {
  @ApiProperty({ description: '队员 id', example: 'cl9z3a8b00000abcd1234efgh' })
  @IsString()
  @Length(8, 64, { message: 'memberId 必须是 8-64 位字符串' })
  memberId!: string;

  @ApiProperty({
    description: '账号级手机号(必填;写入 User.phone,供 login-sms 登录)',
    example: '13800001234',
  })
  @IsString()
  @Matches(MAINLAND_PHONE_PATTERN, { message: 'phone 必须是大陆 11 位手机号' })
  phone!: string;
}

export class BulkGrantMemberAccountsDto {
  @ApiProperty({
    description: `批量开号明细,1-${BULK_GRANT_MAX_ITEMS} 条`,
    type: () => [BulkGrantAccountItemDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_GRANT_MAX_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => BulkGrantAccountItemDto)
  items!: BulkGrantAccountItemDto[];
}

export const BULK_GRANT_ITEM_STATUS_VALUES = ['ok', 'blocked'] as const;
export type BulkGrantItemStatus = (typeof BULK_GRANT_ITEM_STATUS_VALUES)[number];

export class BulkGrantAccountResultItemDto {
  @ApiProperty({ description: '队员 id(原样回显入参)' })
  memberId!: string;

  @ApiProperty({ enum: BULK_GRANT_ITEM_STATUS_VALUES })
  status!: BulkGrantItemStatus;

  // 队员账号闭环 v2:`!:`(非 `?:`)+ 显式 null,沿本文件 MemberResponseDto.userId/accountStatus
  // 既有范式——`?: string | null` 在 @nestjs/swagger 类型推断下会退化成 `type: object`
  // (已由 contract snapshot 实测发现),故恒回显两键、不适用时为 null,而非省略键。
  @ApiPropertyOptional({ description: '新建账号 id(仅 status=ok,否则 null)', nullable: true })
  userId!: string | null;

  @ApiPropertyOptional({
    description: '失败原因(仅 status=blocked,否则 null;取自对应 BizException 的 message)',
    nullable: true,
  })
  reason!: string | null;
}

export class BulkGrantSummaryDto {
  @ApiProperty({ description: '本次请求总行数' })
  total!: number;

  @ApiProperty({ description: '成功行数' })
  ok!: number;

  @ApiProperty({ description: '失败行数(不阻断其余行)' })
  blocked!: number;
}

export class BulkGrantMemberAccountsResponseDto {
  @ApiProperty({ type: () => [BulkGrantAccountResultItemDto] })
  items!: BulkGrantAccountResultItemDto[];

  @ApiProperty({ type: () => BulkGrantSummaryDto })
  summary!: BulkGrantSummaryDto;
}
