import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import { CONTENT_PUBLIC_THROTTLER_NAME } from '../common/decorators/content-public-throttle.decorator';
import { LOGIN_SMS_THROTTLER_NAME } from '../common/decorators/login-sms-throttle.decorator';
import { LOGIN_WECHAT_THROTTLER_NAME } from '../common/decorators/login-wechat-throttle.decorator';
import { RECRUITMENT_THROTTLER_NAME } from '../common/decorators/recruitment-throttle.decorator';
import { PASSWORD_CHANGE_THROTTLER_NAME } from '../common/decorators/password-change-throttle.decorator';
import { PASSWORD_RESET_THROTTLER_NAME } from '../common/decorators/password-reset-throttle.decorator';
import { REFRESH_THROTTLER_NAME } from '../common/decorators/refresh-throttle.decorator';
import { SMS_SEND_THROTTLER_NAME } from '../common/decorators/sms-send-throttle.decorator';
import { SMS_VERIFY_THROTTLER_NAME } from '../common/decorators/sms-verify-throttle.decorator';
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
      // SMS 基础设施 T3(2026-06-10):发码 / 验码两个独立实例(评审稿 D-SMS-6 / E-23;
      // 与既有三实例物理隔离,五实例计数器互不影响)。
      {
        name: SMS_SEND_THROTTLER_NAME,
        limit: appCfg.smsSendThrottle.limit,
        ttl: appCfg.smsSendThrottle.ttlSeconds * 1000,
      },
      {
        name: SMS_VERIFY_THROTTLER_NAME,
        limit: appCfg.smsVerifyThrottle.limit,
        ttl: appCfg.smsVerifyThrottle.ttlSeconds * 1000,
      },
      // 找回密码 T2(2026-06-11):pre-auth 两端点第 6 实例(评审稿 D-PR-4 / E-10;
      // 默认 3/60 从紧,六实例计数器互不影响)。
      {
        name: PASSWORD_RESET_THROTTLER_NAME,
        limit: appCfg.passwordResetThrottle.limit,
        ttl: appCfg.passwordResetThrottle.ttlSeconds * 1000,
      },
      // B 队列 F4-T2(2026-06-11):OTP 登录 pre-auth 两端点第 7 实例
      // (评审稿 queue-b E-O3;默认 5/60 goal 拍板值,七实例计数器互不影响)。
      {
        name: LOGIN_SMS_THROTTLER_NAME,
        limit: appCfg.loginSmsThrottle.limit,
        ttl: appCfg.loginSmsThrottle.ttlSeconds * 1000,
      },
      // 微信小程序登录 T3(2026-06-12):微信 pre-auth 三端点第 8 实例
      // (wechat 评审稿 E-17;默认 5/60 镜像 login-sms,八实例计数器互不影响)。
      {
        name: LOGIN_WECHAT_THROTTLER_NAME,
        limit: appCfg.loginWechatThrottle.limit,
        ttl: appCfg.loginWechatThrottle.ttlSeconds * 1000,
      },
      // 招新一期 T3(2026-06-18):招新报名公开两端点第 9 实例
      // (评审稿 E-R-25;默认 10/3600 名额有限防重复/高频,九实例计数器互不影响)。
      {
        name: RECRUITMENT_THROTTLER_NAME,
        limit: appCfg.recruitmentThrottle.limit,
        ttl: appCfg.recruitmentThrottle.ttlSeconds * 1000,
      },
      // CMS 内容发布模块 T3(2026-06-21):open/v1 内容读取面两端点第 10 实例
      // (评审稿 §7;默认 60/60 读取适配,十实例计数器互不影响)。
      {
        name: CONTENT_PUBLIC_THROTTLER_NAME,
        limit: appCfg.contentPublicThrottle.limit,
        ttl: appCfg.contentPublicThrottle.ttlSeconds * 1000,
      },
    ],
    setHeaders: false,
  };
}
