import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerRequest } from '@nestjs/throttler';
import { LOGIN_THROTTLE_KEY } from '../decorators/login-throttle.decorator';
import {
  PASSWORD_CHANGE_THROTTLE_KEY,
  PASSWORD_CHANGE_THROTTLER_NAME,
} from '../decorators/password-change-throttle.decorator';
import {
  PASSWORD_RESET_THROTTLE_KEY,
  PASSWORD_RESET_THROTTLER_NAME,
} from '../decorators/password-reset-throttle.decorator';
import {
  REFRESH_THROTTLE_KEY,
  REFRESH_THROTTLER_NAME,
} from '../decorators/refresh-throttle.decorator';
import {
  SMS_SEND_THROTTLE_KEY,
  SMS_SEND_THROTTLER_NAME,
} from '../decorators/sms-send-throttle.decorator';
import {
  SMS_VERIFY_THROTTLE_KEY,
  SMS_VERIFY_THROTTLER_NAME,
} from '../decorators/sms-verify-throttle.decorator';
import { BizCode } from '../exceptions/biz-code.constant';
import { BizException } from '../exceptions/biz.exception';

// V1.1 §11.4 / TASKS.md 15.7:登录限流入口(metadata = LOGIN_THROTTLE_KEY,走 throttler `default`)。
// P0-D PR-3(2026-05-17):本人改密限流入口(metadata = PASSWORD_CHANGE_THROTTLE_KEY,走 throttler `password-change`)。
// P0-E PR-3(2026-05-18):refresh 限流入口(metadata = REFRESH_THROTTLE_KEY,走 throttler `refresh`)。
// SMS T3(2026-06-10):发码 / 验码限流入口(metadata = SMS_SEND/VERIFY_THROTTLE_KEY,
// 走 throttler `sms-send` / `sms-verify`;评审稿 D-SMS-6 / E-23,沿既有三实例同型扩展)。
// 找回密码 T2(2026-06-11):pre-auth 两端点限流入口(metadata = PASSWORD_RESET_THROTTLE_KEY,
// 走 throttler `password-reset`;评审稿 password-reset-by-sms-review.md D-PR-4 / E-10,同型扩展)。
//
// 六个 throttler 实例在 ThrottlerModule.forRootAsync 中注册(详见 bootstrap/throttle-options.ts),
// 物理隔离:登录失败爆破不消耗改密 / refresh / 发码配额,反之亦然。
//
// 与 ThrottlerGuard 的三点定制:
//   1. shouldSkip 默认 true:全局 APP_GUARD 注册后,所有未标 @LoginThrottle() / @PasswordChangeThrottle()
//      / @RefreshThrottle() 的方法直接跳过限流(反向白名单)。
//   2. handleRequest 按 throttler.name 与当前 metadata 匹配:
//      - throttler `default` 仅对标 @LoginThrottle() 的方法生效
//      - throttler `password-change` 仅对标 @PasswordChangeThrottle() 的方法生效
//      - throttler `refresh` 仅对标 @RefreshThrottle() 的方法生效
//      - 其他组合直接 return true(不消耗配额、不抛异常)
//   3. throwThrottlingException 重写:抛 BizException(BizCode.TOO_MANY_REQUESTS),
//      经 AllExceptionsFilter 输出统一 { code: 42900, message, data: null } + HTTP 429。
//      不抛 throttler 默认的 ThrottlerException(后者会绕过统一错误码体系)。
//
// 不暴露阈值/剩余配额/重置时间:通过 ThrottlerModule.forRootAsync 顶层 setHeaders: false 关闭
// X-RateLimit-* / Retry-After 头(沿 V1.1 §17.7 / 评审稿 §5.4 / §5.8)。
//
// 全局 APP_GUARD 顺序:ThrottlerBizGuard → JwtAuthGuard → RolesGuard。
@Injectable()
export class ThrottlerBizGuard extends ThrottlerGuard {
  // 父类签名是 Promise<boolean>,但本实现纯同步(只读 reflector metadata),
  // 用 Promise.resolve 包装匹配签名,避免 async 关键字触发 require-await lint。
  protected shouldSkip(context: ExecutionContext): Promise<boolean> {
    const loginEnabled = this.reflector.getAllAndOverride<boolean | undefined>(LOGIN_THROTTLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const passwordChangeEnabled = this.reflector.getAllAndOverride<boolean | undefined>(
      PASSWORD_CHANGE_THROTTLE_KEY,
      [context.getHandler(), context.getClass()],
    );
    const refreshEnabled = this.reflector.getAllAndOverride<boolean | undefined>(
      REFRESH_THROTTLE_KEY,
      [context.getHandler(), context.getClass()],
    );
    const smsSendEnabled = this.reflector.getAllAndOverride<boolean | undefined>(
      SMS_SEND_THROTTLE_KEY,
      [context.getHandler(), context.getClass()],
    );
    const smsVerifyEnabled = this.reflector.getAllAndOverride<boolean | undefined>(
      SMS_VERIFY_THROTTLE_KEY,
      [context.getHandler(), context.getClass()],
    );
    const passwordResetEnabled = this.reflector.getAllAndOverride<boolean | undefined>(
      PASSWORD_RESET_THROTTLE_KEY,
      [context.getHandler(), context.getClass()],
    );
    // 未标任何一种 metadata 时全部跳过;任一 metadata 命中即进入限流逻辑,
    // 由 handleRequest 按 throttler.name 决定具体走哪个 throttler。
    return Promise.resolve(
      !(
        loginEnabled === true ||
        passwordChangeEnabled === true ||
        refreshEnabled === true ||
        smsSendEnabled === true ||
        smsVerifyEnabled === true ||
        passwordResetEnabled === true
      ),
    );
  }

  // 父类签名为 protected handleRequest(req: ThrottlerRequest): Promise<boolean>。
  // 同 canActivate 内对每个 throttler 调用一次,返回 true 表示放过该 throttler。
  // 我们按 throttler.name 与 metadata 的对应关系判断:不匹配 → 直接放过(不计数、不抛)。
  protected handleRequest(req: ThrottlerRequest): Promise<boolean> {
    const { context, throttler } = req;
    const loginEnabled = this.reflector.getAllAndOverride<boolean | undefined>(LOGIN_THROTTLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const passwordChangeEnabled = this.reflector.getAllAndOverride<boolean | undefined>(
      PASSWORD_CHANGE_THROTTLE_KEY,
      [context.getHandler(), context.getClass()],
    );
    const refreshEnabled = this.reflector.getAllAndOverride<boolean | undefined>(
      REFRESH_THROTTLE_KEY,
      [context.getHandler(), context.getClass()],
    );
    const smsSendEnabled = this.reflector.getAllAndOverride<boolean | undefined>(
      SMS_SEND_THROTTLE_KEY,
      [context.getHandler(), context.getClass()],
    );
    const smsVerifyEnabled = this.reflector.getAllAndOverride<boolean | undefined>(
      SMS_VERIFY_THROTTLE_KEY,
      [context.getHandler(), context.getClass()],
    );
    const passwordResetEnabled = this.reflector.getAllAndOverride<boolean | undefined>(
      PASSWORD_RESET_THROTTLE_KEY,
      [context.getHandler(), context.getClass()],
    );

    // throttler `default` 仅服务 LoginThrottle;否则直接放过
    if (throttler.name === 'default' && loginEnabled !== true) {
      return Promise.resolve(true);
    }
    // throttler `password-change` 仅服务 PasswordChangeThrottle;否则直接放过
    if (throttler.name === PASSWORD_CHANGE_THROTTLER_NAME && passwordChangeEnabled !== true) {
      return Promise.resolve(true);
    }
    // throttler `refresh` 仅服务 RefreshThrottle;否则直接放过
    if (throttler.name === REFRESH_THROTTLER_NAME && refreshEnabled !== true) {
      return Promise.resolve(true);
    }
    // throttler `sms-send` 仅服务 SmsSendThrottle;否则直接放过
    if (throttler.name === SMS_SEND_THROTTLER_NAME && smsSendEnabled !== true) {
      return Promise.resolve(true);
    }
    // throttler `sms-verify` 仅服务 SmsVerifyThrottle;否则直接放过
    if (throttler.name === SMS_VERIFY_THROTTLER_NAME && smsVerifyEnabled !== true) {
      return Promise.resolve(true);
    }
    // throttler `password-reset` 仅服务 PasswordResetThrottle;否则直接放过
    if (throttler.name === PASSWORD_RESET_THROTTLER_NAME && passwordResetEnabled !== true) {
      return Promise.resolve(true);
    }

    return super.handleRequest(req);
  }

  // 父类签名为 protected throwThrottlingException(context, detail): Promise<void>。
  // 我们不消费 context / detail——message / httpStatus / code 全部由 BizCode 决定,
  // 故意不把限流细节带进 BizException(任务卡 15.7 + 评审稿 §5.4:不暴露阈值/剩余配额/重置时间)。
  // throw 让函数返回 never,签名上仍兼容 Promise<void>。
  protected throwThrottlingException(): Promise<void> {
    throw new BizException(BizCode.TOO_MANY_REQUESTS);
  }
}
