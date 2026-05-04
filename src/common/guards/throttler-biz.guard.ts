import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { LOGIN_THROTTLE_KEY } from '../decorators/login-throttle.decorator';
import { BizCode } from '../exceptions/biz-code.constant';
import { BizException } from '../exceptions/biz.exception';

// V1.1 §11.4 / TASKS.md 15.7:把 throttler 命中限流时的异常转为 BizException,
// 经 AllExceptionsFilter 输出统一 { code: 42900, message, data: null } + HTTP 429。
//
// 与 ThrottlerGuard 的两点定制:
//   1. shouldSkip 默认 true:全局 APP_GUARD 注册后,所有未标 @LoginThrottle() 的方法
//      直接跳过限流。等价于"全局默认 @SkipThrottle"语义,但通过反向白名单实现,
//      避免在每个业务 controller 上加 @SkipThrottle 污染。
//   2. throwThrottlingException 重写:抛 BizException(BizCode.TOO_MANY_REQUESTS),
//      不抛 throttler 默认的 ThrottlerException——后者会绕过统一错误码体系。
//
// 不暴露阈值/剩余配额/重置时间:通过 ThrottlerModule.forRootAsync 顶层 setHeaders: false
// 关闭 X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset / Retry-After 头
// 写入(详见 throttler.guard.js handleRequest)。本 guard 不需要单独移除 header。
//
// 全局 APP_GUARD 顺序:ThrottlerBizGuard → JwtAuthGuard → RolesGuard。
// 限流是粗粒度的"先挡爆破",必须先于 JWT 校验执行(否则爆破时每次都会走完 JWT 解析,
// CPU 消耗放大);且登录接口本身 @Public(),无 JWT 校验依赖。
@Injectable()
export class ThrottlerBizGuard extends ThrottlerGuard {
  // 父类签名是 Promise<boolean>,但本实现纯同步(只读 reflector metadata),
  // 用 Promise.resolve 包装匹配签名,避免 async 关键字触发 require-await lint。
  protected shouldSkip(context: ExecutionContext): Promise<boolean> {
    const enabled = this.reflector.getAllAndOverride<boolean | undefined>(LOGIN_THROTTLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    return Promise.resolve(enabled !== true);
  }

  // 父类签名为 protected throwThrottlingException(context, detail): Promise<void>。
  // 我们不消费 context / detail——message / httpStatus / code 全部由 BizCode 决定,
  // 故意不把限流细节带进 BizException(任务卡 15.7:不暴露阈值/剩余配额/重置时间)。
  // throw 让函数返回 never,签名上仍兼容 Promise<void>。
  protected throwThrottlingException(): Promise<void> {
    throw new BizException(BizCode.TOO_MANY_REQUESTS);
  }
}
