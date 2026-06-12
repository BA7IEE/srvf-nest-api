import { SetMetadata } from '@nestjs/common';

// 微信小程序登录 T3(2026-06-12):微信 pre-auth 三端点限流"白名单标记"装饰器
// (冻结评审稿 docs/archive/reviews/wechat-mini-login-review.md E-17;
// 沿 login-sms-throttle.decorator.ts 设计范式)。
//
// - 纯 metadata 标记;limit / ttl 来自 app.config.ts `loginWechatThrottle`(默认 IP 5 次 / 60 秒,
//   镜像 login-sms 拍板值;pre-auth 公开端点,IP 层是防侧写采样与上游 API 滥用的第一道闸)
// - 物理隔离:throttler.module 内 `login-wechat` 是第 8 个独立 throttler 实例,与
//   default(登录)/ password-change / refresh / sms-send / sms-verify / password-reset /
//   login-sms 计数器互不影响
// - ThrottlerBizGuard 看到本 metadata 即启用限流;命中统一抛
//   BizException(BizCode.TOO_MANY_REQUESTS) → HTTP 429,不暴露阈值
//
// 用法:
//   @LoginWechatThrottle()
//   @Post('login-wechat')
//
// 仅用于 POST /api/auth/v1/login-wechat 与 POST /api/auth/v1/wechat-bind{,/send-code}
// 三个 pre-auth 端点(计数按 端点×IP 维度,三端点各自计数;send-code 端点另有
// SmsCodeService DB 层同号 60s/日 10 条对有效号兜底);其他接口要限流应单独评估,
// 不要复用本装饰器(沿"禁止顺手对所有接口加限流"纪律)。
export const LOGIN_WECHAT_THROTTLE_KEY = 'login-wechat-throttle:enabled';

export const LOGIN_WECHAT_THROTTLER_NAME = 'login-wechat';

export const LoginWechatThrottle = (): MethodDecorator & ClassDecorator =>
  SetMetadata(LOGIN_WECHAT_THROTTLE_KEY, true);
