import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Role, UserStatus } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

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

// v1 不引入 q / role / status 过滤,仅继承分页参数。
export class ListUsersQueryDto extends PaginationQueryDto {}
