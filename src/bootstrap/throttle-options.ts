import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import { PASSWORD_CHANGE_THROTTLER_NAME } from '../common/decorators/password-change-throttle.decorator';
import { REFRESH_THROTTLER_NAME } from '../common/decorators/refresh-throttle.decorator';
import type { AppConfig } from '../config/app.config';

// V1.1 §11.4 / TASKS.md 15.7:登录接口限流(throttler `default` 实例)。
// P0-D PR-3(2026-05-17):本人改密接口限流(独立 throttler `password-change` 实例;
// 沿 docs/first-release-p0d-change-my-password-review.md §5.4 + §6 行 214)。
// P0-E PR-3(2026-05-18):refresh 接口限流(独立 throttler `refresh` 实例;
// 沿 docs/first-release-p0e-refresh-token-review.md §3.7 D-7 + §5.8)。
//
// 设计要点:
//   - 内存 storage(默认 ThrottlerStorageService),不引入 Redis(沿 V1.1 §17.2 / §17.3)
//   - 三个 throttler 实例**物理隔离**:登录失败爆破不会消耗改密 / refresh 配额,反之亦然
//   - ThrottlerBizGuard.shouldSkip 默认 true:仅 @LoginThrottle() / @PasswordChangeThrottle()
//     / @RefreshThrottle() 标注的方法才走对应 throttler 的 limit/ttl 检查;按 metadata 决定走哪个 throttler
//   - setHeaders: false 完全关闭 X-RateLimit-* / Retry-After 头(任务卡 15.7 / 评审稿 §5.4 / §5.8)
export function buildThrottlerOptions(appCfg: AppConfig): ThrottlerModuleOptions {
  return {
    throttlers: [
      {
        name: 'default',
        limit: appCfg.loginThrottle.limit,
        // throttler ttl 单位是毫秒,app.config 暴露秒数(运维更直观),这里换算 ms。
        ttl: appCfg.loginThrottle.ttlSeconds * 1000,
      },
      {
        name: PASSWORD_CHANGE_THROTTLER_NAME,
        limit: appCfg.passwordChangeThrottle.limit,
        ttl: appCfg.passwordChangeThrottle.ttlSeconds * 1000,
      },
      {
        name: REFRESH_THROTTLER_NAME,
        limit: appCfg.refreshThrottle.limit,
        ttl: appCfg.refreshThrottle.ttlSeconds * 1000,
      },
    ],
    setHeaders: false,
  };
}
