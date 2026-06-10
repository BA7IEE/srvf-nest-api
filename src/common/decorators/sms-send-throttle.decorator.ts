import { SetMetadata } from '@nestjs/common';

// SMS 基础设施 T3(2026-06-10):send-code 接口限流"白名单标记"装饰器
// (评审稿 D-SMS-6 / E-23;沿 password-change-throttle.decorator.ts 设计范式)。
//
// - 纯 metadata 标记;limit / ttl 来自 app.config.ts `smsSendThrottle`(默认 IP 5 次 / 60 秒)
// - 物理隔离:throttler.module 内 `sms-send` 是独立 throttler 实例,与
//   default(登录)/ password-change / refresh / sms-verify 计数器互不影响
// - ThrottlerBizGuard 看到本 metadata 即启用限流;命中统一抛
//   BizException(BizCode.TOO_MANY_REQUESTS) → HTTP 429,不暴露阈值
//
// 用法:
//   @SmsSendThrottle()
//   @Post('phone/send-code')
//
// 仅用于 App 发码端点 POST /api/app/v1/me/phone/send-code;其他接口要限流应单独评估,
// 不要复用本装饰器(沿"禁止顺手对所有接口加限流"纪律)。
export const SMS_SEND_THROTTLE_KEY = 'sms-send-throttle:enabled';

export const SMS_SEND_THROTTLER_NAME = 'sms-send';

export const SmsSendThrottle = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SMS_SEND_THROTTLE_KEY, true);
