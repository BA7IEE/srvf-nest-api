import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';

import { MAINLAND_PHONE_PATTERN, SMS_CODE_LENGTH } from '../sms/sms.constants';

// 登录入参严格按 ARCHITECTURE.md §6 / §7.6:仅 username + password,
// 不支持 email / 手机号 / 验证码登录。
//
// username 校验策略:
// - DTO 层做格式与长度校验(3-32,字母/数字/下划线/中横线),允许大小写
// - service 内部统一 trim() + toLowerCase() 后用于查询
//
// password 校验策略:
// - 仅 @IsString + @IsNotEmpty,不做 @MinLength
// - 登录阶段不应通过密码长度规则区分失败原因(防泄漏密码强度规则)
export class LoginDto {
  @ApiProperty({
    description:
      '用户名(允许字母 / 数字 / 下划线 / 中横线,长度 3-32);' +
      'service 内部统一 trim + lowercase 后用于查询',
    example: 'admin',
    minLength: 3,
    maxLength: 32,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message: 'username 只允许字母 / 数字 / 下划线 / 中横线',
  })
  username!: string;

  @ApiProperty({
    description: '密码(明文,服务端用 bcrypt 比对);此接口刻意不做长度规则校验',
    example: 'YourPassword123',
    format: 'password',
  })
  @IsString()
  @IsNotEmpty()
  password!: string;
}

// P0-E PR-3(2026-05-18):LoginResponseDto 扩展 refreshToken + refreshExpiresAt 2 字段
// (向后兼容;旧前端忽略未知字段;字段集恰好 5 项;扩展后禁止再增字段)。
// 沿 docs/first-release-p0e-refresh-token-review.md §3.1 D-1。
export class LoginResponseDto {
  @ApiProperty({ description: 'JWT access token,前端拼 Authorization: Bearer <token>' })
  accessToken!: string;

  @ApiProperty({ description: 'token 类型', example: 'Bearer' })
  tokenType!: 'Bearer';

  @ApiProperty({
    description: '过期时间,原样回传 JWT_EXPIRES_IN 配置值',
    example: '15m',
  })
  expiresIn!: string;

  // P0-E PR-3:refresh token(opaque random 256bit base64url;不是 JWT)。
  // 客户端不应也不能解析其中信息;明文绝不入日志 / audit / OpenAPI 示例 / 测试快照。
  // 前端调 POST /api/auth/v1/refresh 用此 token 换取新的 access + refresh(rotation always)。
  @ApiProperty({
    description: 'refresh token(opaque random;不是 JWT);用于 POST /api/auth/v1/refresh 换 access',
  })
  refreshToken!: string;

  // P0-E PR-3:refresh token family absolute expiration 时刻
  // (ISO 8601 UTC 字符串;new Date(...).toISOString() 格式)。
  // rotation 后所有新 refresh token 继承同一个 refreshExpiresAt,不延长;
  // 达到此时刻后必须重新登录(POST /api/auth/v1/login);refresh 接口对已过期 family
  // 返 REFRESH_TOKEN_INVALID=10007。客户端无需信任本地时钟做 now + TTL 计算。
  @ApiProperty({
    description:
      'refresh token family absolute expiration 时刻(ISO 8601 UTC);rotation 后新 token 继承同一时刻;' +
      '达到此时刻后必须重新登录;客户端读此字段即知 family 何时过期,无需本地时钟参与',
    example: '2026-08-16T00:00:00.000Z',
  })
  refreshExpiresAt!: string;
}

// P0-E PR-3:POST /api/auth/v1/refresh 入参(沿评审稿 §4.2;严格白名单 1 字段)。
export class RefreshTokenDto {
  @ApiProperty({
    description: 'refresh token 明文(login / 上一次 refresh 接口响应里拿到的 data.refreshToken)',
  })
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

// P0-E PR-3:POST /api/auth/v1/logout 入参(沿评审稿 §4.3;严格白名单 1 字段)。
// 与 RefreshTokenDto 字段结构相同;独立类型用于 OpenAPI 区分 + 未来分化可能。
export class LogoutDto {
  @ApiProperty({
    description: '要撤销的 refresh token 明文;幂等(不存在 / 已撤销 / 已过期 → 仍返 200)',
  })
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

// P0-E PR-3:POST /api/auth/v1/logout-all 响应 data(沿评审稿 §4.4)。
export class LogoutAllResponseDto {
  @ApiProperty({
    description: '本次撤销的 refresh token 行数(未过期且未撤销的总数)',
    example: 3,
  })
  revokedCount!: number;
}

// ===== 找回密码 T2(2026-06-11;冻结评审稿 password-reset-by-sms-review.md §3.2 / E-8/E-9)=====
//
// pre-auth DTO 纪律:严格字段白名单(forbidNonWhitelisted 兜底);
// phone 沿 MAINLAND_PHONE_PATTERN(SMS 评审稿 E-17),code 沿 6 位数字,
// newPassword **镜像 ChangeMyPasswordDto.newPassword**(8-128 + 字母数字);
// 响应永不含验证码 / token / 用户字段(防枚举 §4 + D-PR-1 不自动登录)。

export class SendPasswordResetCodeDto {
  @ApiProperty({
    description: '账号绑定的大陆手机号(11 位);防枚举:无效号码返回完全相同的泛化响应',
    example: '13800001234',
  })
  @IsString()
  @Matches(MAINLAND_PHONE_PATTERN, { message: 'phone 必须是大陆 11 位手机号' })
  phone!: string;
}

export class SendPasswordResetCodeResponseDto {
  @ApiProperty({ description: '验证码有效期(秒;固定 300)', example: 300 })
  expiresInSeconds!: number;
}

// ===== OTP 登录 F4-T2(2026-06-11;冻结评审稿 queue-b-otp-birthday-infra-review.md §5.2 / E-O8)=====
//
// pre-auth DTO 纪律同找回密码:严格字段白名单;phone 沿 MAINLAND_PHONE_PATTERN,
// code 沿 6 位数字;登录成功响应**复用 LoginResponseDto**(与密码登录同 DTO,goal 拍板);
// send-code 响应复用 SendPasswordResetCodeResponseDto 形状(同模块内复用,非跨模块)。

export class SendLoginSmsCodeDto {
  @ApiProperty({
    description: '账号绑定的大陆手机号(11 位);防枚举:无效号码返回完全相同的泛化响应',
    example: '13800001234',
  })
  @IsString()
  @Matches(MAINLAND_PHONE_PATTERN, { message: 'phone 必须是大陆 11 位手机号' })
  phone!: string;
}

export class LoginSmsDto {
  @ApiProperty({
    description: '账号绑定的大陆手机号(11 位;须与 send-code 时一致)',
    example: '13800001234',
  })
  @IsString()
  @Matches(MAINLAND_PHONE_PATTERN, { message: 'phone 必须是大陆 11 位手机号' })
  phone!: string;

  @ApiProperty({ description: '6 位数字验证码', example: '123456' })
  @IsString()
  @Length(SMS_CODE_LENGTH, SMS_CODE_LENGTH)
  @Matches(/^\d{6}$/, { message: 'code 必须是 6 位数字' })
  code!: string;
}

export class ResetPasswordBySmsDto {
  @ApiProperty({
    description: '账号绑定的大陆手机号(11 位;须与 send-code 时一致)',
    example: '13800001234',
  })
  @IsString()
  @Matches(MAINLAND_PHONE_PATTERN, { message: 'phone 必须是大陆 11 位手机号' })
  phone!: string;

  @ApiProperty({ description: '6 位数字验证码', example: '123456' })
  @IsString()
  @Length(SMS_CODE_LENGTH, SMS_CODE_LENGTH)
  @Matches(/^\d{6}$/, { message: 'code 必须是 6 位数字' })
  code!: string;

  @ApiProperty({
    description:
      '新密码(至少 8 位,需含字母+数字);与当前密码相同抛 NEW_PASSWORD_SAME_AS_OLD(10006,不消费验证码,可换密码用同码重试)',
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
