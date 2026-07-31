import { SetMetadata } from '@nestjs/common';

// 企业微信接入 T2(2026-08-01):企业微信 pre-auth 端点限流"白名单标记"装饰器
// (冻结稿 docs/archive/reviews/wecom-integration-t0-terminal-review.md §11;
// 沿 login-wechat-throttle.decorator.ts 设计范式)。
//
// ⚠️ **本刀只交付这个文件与 app.config 的 limit/ttl —— 骨架,不接线**:
// - throttler 实例注册(`src/bootstrap/throttle-options.ts`)与
//   `ThrottlerBizGuard` 的 name 分派**都在 T3**,与「把本装饰器挂到端点」同 PR 落。
// - 为什么必须成对:guard 是靠**逐 throttler 的 name 判断跳过**的
//   (`if (throttler.name === X && enabled !== true) return true`)。
//   只注册实例、不接 guard,`login-wecom` 就会对**所有已挂其他限流装饰器的端点**
//   多计一道数 —— 那是真实行为变更,而 T2 连一个能实测它的用例都没有。
// - T2 没有任何 pre-auth 企业微信端点(OAuth 与绑定归 T3),现在接线既无处可挂也无从验证。
//
// - 纯 metadata 标记;limit / ttl 来自 app.config.ts `loginWecomThrottle`
//   (默认 IP 5 次 / 60 秒,镜像 login-wechat 拍板值)
// - T3 接线后将是 throttler.module 内**第 11 个**独立实例,与既有十个计数器互不影响
// - 命中统一抛 BizException(BizCode.TOO_MANY_REQUESTS) → HTTP 429,不暴露阈值
//
// 用法(T3):
//   @LoginWecomThrottle()
//   @Post('login-wecom')
//
// 仅用于企业微信 pre-auth 端点(OAuth 回调登录 / 未绑定手机锚定 / bind 相关);
// 其他接口要限流应单独评估,不要复用本装饰器
// (沿"禁止顺手对所有接口加限流"纪律)。
export const LOGIN_WECOM_THROTTLE_KEY = 'login-wecom-throttle:enabled';

export const LOGIN_WECOM_THROTTLER_NAME = 'login-wecom';

export const LoginWecomThrottle = (): MethodDecorator & ClassDecorator =>
  SetMetadata(LOGIN_WECOM_THROTTLE_KEY, true);
