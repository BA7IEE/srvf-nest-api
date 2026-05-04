import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import type { AppConfig } from '../config/app.config';

// V1.1 §11.4 / TASKS.md 15.7:登录接口限流。
// 内存 storage(默认 ThrottlerStorageService),不引入 Redis。
// 默认对所有路径生效,但 ThrottlerBizGuard.shouldSkip 默认 true,
// 仅 @LoginThrottle() 标注的方法才走 limit/ttl 检查(等价于"反向白名单")。
// setHeaders: false 完全关闭 X-RateLimit-* 与 Retry-After 头(任务卡 15.7
// 明确"不暴露阈值数字、剩余配额、重置时间")。
export function buildThrottlerOptions(appCfg: AppConfig): ThrottlerModuleOptions {
  return {
    throttlers: [
      {
        name: 'default',
        limit: appCfg.loginThrottle.limit,
        // throttler ttl 单位是毫秒,app.config 暴露秒数(运维更直观),这里换算 ms。
        ttl: appCfg.loginThrottle.ttlSeconds * 1000,
      },
    ],
    setHeaders: false,
  };
}
