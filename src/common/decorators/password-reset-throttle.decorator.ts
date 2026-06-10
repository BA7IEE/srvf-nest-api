import { SetMetadata } from '@nestjs/common';

// 找回密码 T2(2026-06-11):password-reset 两端点限流"白名单标记"装饰器
// (冻结评审稿 docs/archive/reviews/password-reset-by-sms-review.md D-PR-4 / E-10;
// 沿 sms-send-throttle.decorator.ts 设计范式)。
//
// - 纯 metadata 标记;limit / ttl 来自 app.config.ts `passwordResetThrottle`(默认 IP 3 次 / 60 秒,
//   刻意严于 sms-send 5/60:pre-auth 公开端点,这是防枚举侧信道采样与费用滥用的第一道闸)
// - 物理隔离:throttler.module 内 `password-reset` 是第 6 个独立 throttler 实例,与
//   default(登录)/ password-change / refresh / sms-send / sms-verify 计数器互不影响
// - ThrottlerBizGuard 看到本 metadata 即启用限流;命中统一抛
//   BizException(BizCode.TOO_MANY_REQUESTS) → HTTP 429,不暴露阈值
//
// 用法:
//   @PasswordResetThrottle()
//   @Post('password-reset/send-code')
//
// 仅用于 POST /api/auth/v1/password-reset/send-code 与 POST /api/auth/v1/password-reset
// 两个 pre-auth 端点(计数按 端点×IP 维度,两端点各自计数);其他接口要限流应单独评估,
// 不要复用本装饰器(沿"禁止顺手对所有接口加限流"纪律)。
export const PASSWORD_RESET_THROTTLE_KEY = 'password-reset-throttle:enabled';

export const PASSWORD_RESET_THROTTLER_NAME = 'password-reset';

export const PasswordResetThrottle = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PASSWORD_RESET_THROTTLE_KEY, true);
