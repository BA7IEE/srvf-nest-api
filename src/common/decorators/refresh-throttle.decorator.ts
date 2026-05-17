import { SetMetadata } from '@nestjs/common';

// P0-E PR-3(2026-05-18):refresh 接口限流"白名单标记"装饰器。
// 沿 login-throttle.decorator.ts / password-change-throttle.decorator.ts 设计范式
// (详见同目录文件注释)。
//
// 与既有 throttler 装饰器关系:
//   - 三装饰器都是纯 metadata 标记,limit / ttl 来源不同的 app.config 字段
//   - 物理隔离:throttler.module 内 'refresh' 是独立 throttler 实例
//     (name: REFRESH_THROTTLER_NAME),与 default(登录)/ 'password-change'(改密 +
//     logout-all)计数器互不影响;详见 src/bootstrap/throttle-options.ts
//   - ThrottlerBizGuard 看到任一 metadata 即启用限流;按 metadata 选择对应 throttler
//
// 用法:
//   @Public()
//   @RefreshThrottle()
//   @Post('refresh')
//   ...
//
// 仅打算用于 POST /api/auth/refresh。其他接口若未来要限流,应单独评估业务需求
// (CLAUDE.md §17.9 禁止"接了 throttler 就顺手对所有接口加限流"),不要复用本装饰器。
export const REFRESH_THROTTLE_KEY = 'refresh-throttle:enabled';

// throttler.module 中独立 throttler 实例名;与 default(LoginThrottle 用)
// 与 'password-change'(PasswordChangeThrottle 用)区分。
// 命中限流时仍统一抛 BizException(BizCode.TOO_MANY_REQUESTS) → HTTP 429。
export const REFRESH_THROTTLER_NAME = 'refresh';

export const RefreshThrottle = (): MethodDecorator & ClassDecorator =>
  SetMetadata(REFRESH_THROTTLE_KEY, true);
