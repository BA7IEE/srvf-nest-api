import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Length, Matches } from 'class-validator';

import { MAINLAND_PHONE_PATTERN, SMS_CODE_LENGTH } from '../../../sms/sms.constants';

// SMS 基础设施 T3(2026-06-10):App 手机号绑定 DTO 集合(评审稿 §3.2 ⑤⑥ / E-17 / E-18)。
//
// App DTO 隔离铁律(AGENTS §11 / D-6):独立定义,**禁止**从 Admin DTO
// extends / Pick / Omit / IntersectionType 派生;严格字段白名单
// (forbidNonWhitelisted 兜底)。
//
// 出参纪律:响应**永不**包含验证码;本人可见自己全量号码(评审稿 §8 三问)。

export class SendMyPhoneCodeDto {
  @ApiProperty({
    description: '要绑定的大陆手机号(11 位;若已被任何账号绑定则拒绝)',
    example: '13800001234',
  })
  @IsString()
  @Matches(MAINLAND_PHONE_PATTERN, { message: 'phone 必须是大陆 11 位手机号' })
  phone!: string;
}

export class SendMyPhoneCodeResponseDto {
  @ApiProperty({ description: '验证码有效期(秒;固定 300)', example: 300 })
  expiresInSeconds!: number;
}

export class BindMyPhoneDto {
  @ApiProperty({
    description: '要绑定的大陆手机号(11 位;须与 send-code 时一致)',
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

  @ApiProperty({ description: 'Auth surface 签发、action=PHONE_BIND 的 5 分钟 step-up proof' })
  @IsString()
  @IsNotEmpty()
  stepUpToken!: string;
}

export class AppMePhoneDto {
  @ApiPropertyOptional({
    description: '当前绑定的手机号(本人视角全量;未绑定为 null)',
    nullable: true,
    example: '13800001234',
  })
  phone!: string | null;

  @ApiPropertyOptional({
    description: '最近一次验码绑定成功时刻(ISO 8601;未绑定为 null)',
    nullable: true,
  })
  phoneVerifiedAt!: string | null;
}
