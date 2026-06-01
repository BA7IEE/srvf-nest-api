import { SetMetadata } from '@nestjs/common';

// V1.1 §11.4 / TASKS.md 15.7:登录限流"白名单标记"装饰器。
//
// 设计取舍:
//   - 任务卡建议"全局默认 @SkipThrottle(),只在登录接口加 @Throttle({ default: { limit, ttl } })"。
//     直接用 @Throttle 装饰的问题:limit / ttl 必须是装饰器静态参数,无法在装饰器执行时
//     从 ConfigService 读取 LOGIN_THROTTLE_LIMIT / LOGIN_THROTTLE_TTL_SECONDS(装饰器在
//     类加载阶段执行,DI 容器尚未就绪)。
//   - 因此采用"功能等价"方案:本装饰器只做纯 metadata 标记,limit / ttl 集中在
//     ThrottlerModule.forRootAsync 由 ConfigService 注入(单一事实源)。
//     ThrottlerBizGuard.shouldSkip 默认 true,看到本 metadata 才返回 false 启用限流。
//   - 同样满足任务卡核心约束:仅 POST /api/auth/v1/login 限流;不污染其它 controller;
//     limit / ttl 走 app.config.ts;不在 controller 上 @UseGuards(违反 ARCHITECTURE.md §7.6)。
//
// 用法:
//   @Public()
//   @LoginThrottle()
//   @Post('login')
//   ...
//
// 仅打算用于 POST /api/auth/v1/login。其他接口若未来要限流,应单独评估业务需求(
// CLAUDE.md §17.9 禁止"接了 throttler 就顺手对所有接口加限流"),不要复用本装饰器。
export const LOGIN_THROTTLE_KEY = 'login-throttle:enabled';

export const LoginThrottle = (): MethodDecorator & ClassDecorator =>
  SetMetadata(LOGIN_THROTTLE_KEY, true);
