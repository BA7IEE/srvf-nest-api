import { SetMetadata } from '@nestjs/common';

// SMS 基础设施 T3(2026-06-10):验码绑定接口限流"白名单标记"装饰器
// (评审稿 D-SMS-6 / E-23;沿 password-change-throttle.decorator.ts 设计范式)。
//
// - 纯 metadata 标记;limit / ttl 来自 app.config.ts `smsVerifyThrottle`(默认 IP 10 次 / 60 秒;
//   比 send 宽——验码不产生短信资费,但仍需挡爆破,配合"错 5 次作废"双层防护)
// - 物理隔离:throttler.module 内 `sms-verify` 是独立 throttler 实例
// - 命中统一 BizException(BizCode.TOO_MANY_REQUESTS) → HTTP 429,不暴露阈值
//
// 用法:
//   @SmsVerifyThrottle()
//   @Put('phone')
//
// 仅用于 App 验码绑定端点 PUT /api/app/v1/me/phone;不要复用到其他接口。
export const SMS_VERIFY_THROTTLE_KEY = 'sms-verify-throttle:enabled';

export const SMS_VERIFY_THROTTLER_NAME = 'sms-verify';

export const SmsVerifyThrottle = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SMS_VERIFY_THROTTLE_KEY, true);
