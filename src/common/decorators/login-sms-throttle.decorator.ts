import { SetMetadata } from '@nestjs/common';

// B 队列 F4-T2(2026-06-11):OTP 登录两端点限流"白名单标记"装饰器
// (冻结评审稿 docs/archive/reviews/queue-b-otp-birthday-infra-review.md E-O3;
// 沿 password-reset-throttle.decorator.ts 设计范式)。
//
// - 纯 metadata 标记;limit / ttl 来自 app.config.ts `loginSmsThrottle`(默认 IP 5 次 / 60 秒,
//   goal 拍板值;pre-auth 公开端点,IP 层是防枚举侧信道采样与费用滥用的第一道闸)
// - 物理隔离:throttler.module 内 `login-sms` 是第 7 个独立 throttler 实例,与
//   default(登录)/ password-change / refresh / sms-send / sms-verify / password-reset
//   计数器互不影响
// - ThrottlerBizGuard 看到本 metadata 即启用限流;命中统一抛
//   BizException(BizCode.TOO_MANY_REQUESTS) → HTTP 429,不暴露阈值
//
// 用法:
//   @LoginSmsThrottle()
//   @Post('login-sms/send-code')
//
// 仅用于 POST /api/auth/v1/login-sms/send-code 与 POST /api/auth/v1/login-sms
// 两个 pre-auth 端点(计数按 端点×IP 维度,两端点各自计数);其他接口要限流应单独评估,
// 不要复用本装饰器(沿"禁止顺手对所有接口加限流"纪律)。
export const LOGIN_SMS_THROTTLE_KEY = 'login-sms-throttle:enabled';

export const LOGIN_SMS_THROTTLER_NAME = 'login-sms';

export const LoginSmsThrottle = (): MethodDecorator & ClassDecorator =>
  SetMetadata(LOGIN_SMS_THROTTLE_KEY, true);
