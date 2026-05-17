import { SetMetadata } from '@nestjs/common';

// P0-D PR-3(2026-05-17):本人自助改密接口限流"白名单标记"装饰器。
// 沿 login-throttle.decorator.ts 设计范式(详见同目录文件注释)。
//
// 与 LoginThrottle 关系:
//   - 两者都是纯 metadata 标记,limit / ttl 来源不同的 app.config 字段
//   - 物理隔离:throttler.module 内 password-change 是独立 throttler 实例(name: 'password-change'),
//     与 default(登录用)计数器互不影响;详见 src/bootstrap/throttle-options.ts
//   - ThrottlerBizGuard 看到任一 metadata 即启用限流;按 metadata 选择对应 throttler
//
// 用法:
//   @PasswordChangeThrottle()
//   @Put('me/password')
//   ...
//
// 仅打算用于 PUT /api/users/me/password。其他接口若未来要限流,应单独评估业务需求
// (CLAUDE.md §17.9 禁止"接了 throttler 就顺手对所有接口加限流"),不要复用本装饰器。
export const PASSWORD_CHANGE_THROTTLE_KEY = 'password-change-throttle:enabled';

// throttler.module 中独立 throttler 实例名;与 default(LoginThrottle 用)区分。
// 命中限流时仍统一抛 BizException(BizCode.TOO_MANY_REQUESTS) → HTTP 429。
export const PASSWORD_CHANGE_THROTTLER_NAME = 'password-change';

export const PasswordChangeThrottle = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PASSWORD_CHANGE_THROTTLE_KEY, true);
