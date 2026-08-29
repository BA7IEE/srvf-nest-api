import { SetMetadata } from '@nestjs/common';

// Integration Foundation v1 PR3(规格书 §11.2/§51):service-token 端点限流标记。
// 纯 metadata;limit/ttl 来自 app.config.ts `serviceTokenThrottle`(默认 10 次 / 60 秒)。
// throttler.module 内**第 12 个**独立实例(name: 'service-token'),计数器与既有 11 个互不影响。
// ⚠️ 与 ThrottlerBizGuard 的分派**成对落地**(沿 login-wecom 范式:只注册不接 guard 会让
// service-token 对所有已挂限流装饰器的端点多计一道数)。
export const SERVICE_TOKEN_THROTTLE_KEY = 'service-token-throttle:enabled';

export const SERVICE_TOKEN_THROTTLER_NAME = 'service-token';

export const ServiceTokenThrottle = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SERVICE_TOKEN_THROTTLE_KEY, true);
