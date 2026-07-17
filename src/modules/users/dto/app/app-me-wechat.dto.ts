import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

// 微信小程序登录 T3(2026-06-12):App 微信绑定 DTO 集合(冻结评审稿
// wechat-mini-login-review.md §3.2 ⑦⑧ / E-13 / E-25;镜像 app-me-phone.dto 范式)。
//
// App DTO 隔离铁律(AGENTS §11 / D-6):独立定义,**禁止**从 Admin DTO
// extends / Pick / Omit / IntersectionType 派生;严格字段白名单
// (forbidNonWhitelisted 兜底)。
//
// 出参纪律(评审稿 §6/§8 三问):openid 非 L3 但**不滥回显**——本人视角也只回掩码
// (maskOpenid 前 4 后 4;与 phone「本人可见全量」不同:openid 对用户无输入/校对价值,
// 掩码足以识别"绑的是哪个微信");响应永不含 wx code / session_key。

const WECHAT_CODE_MAX_LENGTH = 128;

export class BindMyWechatDto {
  @ApiProperty({
    description: '微信小程序 wx.login() 产出的一次性 code(5 分钟有效,单次消费)',
    maxLength: WECHAT_CODE_MAX_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(WECHAT_CODE_MAX_LENGTH)
  code!: string;

  @ApiProperty({ description: 'Auth surface 签发、action=WECHAT_BIND 的 5 分钟 step-up proof' })
  @IsString()
  @IsNotEmpty()
  stepUpToken!: string;
}

export class AppMeWechatDto {
  @ApiProperty({ description: '当前账号是否已绑定微信 openid' })
  bound!: boolean;

  @ApiPropertyOptional({
    description: '已绑定的 openid(**一律掩码** 前 4 后 4;未绑定为 null)',
    nullable: true,
    example: 'oABC****wxyz',
  })
  openidMasked!: string | null;
}
