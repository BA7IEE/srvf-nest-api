import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength, MinLength } from 'class-validator';

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

export class LoginResponseDto {
  @ApiProperty({ description: 'JWT access token,前端拼 Authorization: Bearer <token>' })
  accessToken!: string;

  @ApiProperty({ description: 'token 类型', example: 'Bearer' })
  tokenType!: 'Bearer';

  @ApiProperty({
    description: '过期时间,原样回传 JWT_EXPIRES_IN 配置值',
    example: '7d',
  })
  expiresIn!: string;
}
