import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Role, UserStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

// 队员账号闭环 v1(2026-07-07):关联队员摘要投影(仅 memberNo + displayName,不含任何
// 敏感字段)。**仅** admin list / findOne 两处填充(userAdminSelect);其余 UserResponseDto
// 生产者(App 自助 / phone / wechat / 密码流)不选本字段,故字段在响应体里整体缺失
// (TS 可选属性语义,非 null)。
export class UserLinkedMemberDto {
  @ApiProperty({ description: '队员业务唯一编号', example: 'M-0001' })
  memberNo!: string;

  @ApiProperty({ description: '队员称呼 / 显示名', example: 'Demo Member' })
  displayName!: string;
}

// ============ 出参 DTO ============
// UserResponseDto 字段必须与 userSafeSelect 严格同步(详见 §7.9 + users.select.ts)。
// 永不包含 passwordHash / deletedAt。
export class UserResponseDto {
  @ApiProperty({ description: '用户主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: '用户名(归一化为小写)', example: 'admin' })
  username!: string;

  @ApiPropertyOptional({ description: '邮箱', example: 'admin@example.com', nullable: true })
  email!: string | null;

  @ApiPropertyOptional({ description: '昵称', nullable: true })
  nickname!: string | null;

  @ApiPropertyOptional({ description: '头像 key', nullable: true })
  avatarKey!: string | null;

  @ApiProperty({ description: '角色', enum: Role, example: Role.USER })
  role!: Role;

  @ApiProperty({ description: '状态', enum: UserStatus, example: UserStatus.ACTIVE })
  status!: UserStatus;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiPropertyOptional({ description: '最近一次登录时间', nullable: true })
  lastLoginAt!: Date | null;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;

  // 队员账号闭环 v1(2026-07-07):additive、**可选**——仅 admin list / findOne 填充
  // (userAdminSelect);App 自助面(me/password 等)响应体里本字段整体不出现,详见
  // UserLinkedMemberDto 顶部注释。
  @ApiPropertyOptional({
    description: '关联队员 id(仅 admin 列表/详情返回;未关联为 null)',
    nullable: true,
  })
  memberId?: string | null;

  @ApiPropertyOptional({
    description: '关联队员摘要(仅 admin 列表/详情返回;未关联为 null)',
    type: () => UserLinkedMemberDto,
    nullable: true,
  })
  member?: UserLinkedMemberDto | null;
}

// ============ 入参 DTO ============

export class CreateUserDto {
  @ApiProperty({
    description: '用户名(允许字母/数字/下划线/中横线,3-32);service 内统一 trim+lowercase 入库',
    example: 'alice',
    minLength: 3,
    maxLength: 32,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'username 只允许字母 / 数字 / 下划线 / 中横线' })
  username!: string;

  @ApiPropertyOptional({
    description: '邮箱(可选,大小写归一化;空字符串视为未填写)',
    example: 'alice@example.com',
  })
  @IsOptional()
  @IsString()
  @ValidateIf((_o, v: unknown) => typeof v === 'string' && v.trim().length > 0)
  @IsEmail()
  email?: string;

  @ApiProperty({
    description: '密码(至少 8 位,需含字母+数字)',
    format: 'password',
    minLength: 8,
    maxLength: 128,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^(?=.*[a-zA-Z])(?=.*\d).+$/, {
    message: 'password 至少 8 位,且必须包含字母和数字',
  })
  password!: string;

  @ApiPropertyOptional({ description: '昵称', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  nickname?: string;

  @ApiPropertyOptional({ description: '头像 key', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  avatarKey?: string;

  @ApiPropertyOptional({
    description: '角色;v1 业务 API 永不允许 SUPER_ADMIN;ADMIN 调用时只能创建 USER;不传默认 USER',
    enum: Role,
    default: Role.USER,
  })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;
}

// 本人改资料严格白名单:仅 nickname / avatarKey;
// username / email / password / role / status / deletedAt / id 一律不接受。
export class UpdateMyProfileDto {
  @ApiPropertyOptional({ description: '昵称', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  nickname?: string;

  @ApiPropertyOptional({ description: '头像 key', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  avatarKey?: string;
}

// 管理员改资料:email / nickname / avatarKey;不允许 username(v1 创建后不可改);
// 不允许 role / password / status —— 各走单独接口。
export class UpdateUserDto {
  @ApiPropertyOptional({
    description: '邮箱;传空字符串视为清空(入库 null)',
  })
  @IsOptional()
  @IsString()
  @ValidateIf((_o, v: unknown) => typeof v === 'string' && v.trim().length > 0)
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ description: '昵称', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  nickname?: string;

  @ApiPropertyOptional({ description: '头像 key', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  avatarKey?: string;
}

export class ResetUserPasswordDto {
  @ApiProperty({
    description: '新密码(至少 8 位,需含字母+数字);管理员重置无需 oldPassword',
    format: 'password',
    minLength: 8,
    maxLength: 128,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^(?=.*[a-zA-Z])(?=.*\d).+$/, {
    message: 'password 至少 8 位,且必须包含字母和数字',
  })
  newPassword!: string;
}

// P0-D 本人自助改密 DTO(沿 docs/first-release-p0d-change-my-password-review.md §5.1)。
// 严格白名单只允许 oldPassword + newPassword;额外字段被全局 forbidNonWhitelisted 兜底拒绝。
// oldPassword 仅做 @IsString + @IsNotEmpty(不暴露强度规则,与 LoginDto.password 对齐;
// 详见评审稿 §5.1)。newPassword 强度规则与 ResetUserPasswordDto.newPassword 完全一致。
export class ChangeMyPasswordDto {
  @ApiProperty({
    description: '当前密码;校验失败抛 OLD_PASSWORD_INVALID(10005)',
    format: 'password',
  })
  @IsString()
  @IsNotEmpty()
  oldPassword!: string;

  @ApiProperty({
    description:
      '新密码(至少 8 位,需含字母+数字);若与 oldPassword 完全相同抛 NEW_PASSWORD_SAME_AS_OLD(10006)',
    format: 'password',
    minLength: 8,
    maxLength: 128,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^(?=.*[a-zA-Z])(?=.*\d).+$/, {
    message: 'password 至少 8 位,且必须包含字母和数字',
  })
  newPassword!: string;
}

export class UpdateUserRoleDto {
  @ApiProperty({
    description: '目标角色;不允许 SUPER_ADMIN(只有 seed 能创建)',
    enum: Role,
    example: Role.ADMIN,
  })
  @IsEnum(Role)
  role!: Role;
}

export class UpdateUserStatusDto {
  @ApiProperty({ description: '目标状态', enum: UserStatus, example: UserStatus.DISABLED })
  @IsEnum(UserStatus)
  status!: UserStatus;
}

// F1/A2(路线图 §4;D1 拍板):新增可选 q(模糊命中 username+nickname+email+phone)/
// role / status / memberId。canViewUser 可见性裁剪保留(service 层 AND 叠加,不放宽)。
// 旧字段(空)/响应形状不变(additive)。
export class ListUsersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '模糊搜索(跨字段命中 username + nickname + email + phone)',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ description: '按内置角色过滤', enum: Role })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @ApiPropertyOptional({ description: '按账号状态过滤', enum: UserStatus })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @ApiPropertyOptional({ description: '按绑定的 member id 过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  memberId?: string;
}

// ============ F1/A2 选择器(路线图 §4;D2/D3 拍板)============

export class UserOptionsQueryDto {
  @ApiPropertyOptional({
    description: '模糊搜索(跨字段命中 username + nickname + email + phone)',
    maxLength: 100,
  })
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

export class UserOptionItemDto {
  @ApiProperty({ description: '主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '展示标签(= nickname || username)' })
  label!: string;

  @ApiProperty({ description: '用户名' })
  username!: string;
}

export class UserOptionsResponseDto {
  @ApiProperty({ description: '结果列表(不分页,受 limit 截断)', type: () => [UserOptionItemDto] })
  items!: UserOptionItemDto[];
}
