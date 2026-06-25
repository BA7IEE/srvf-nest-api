// 微信小程序登录 T2(2026-06-12):模块常量
//
// 沿冻结评审稿 docs/archive/reviews/wechat-mini-login-review.md(下称"评审稿")。

// ===== code2session(E-2 / E-11)=====
// 微信官方 jscode2session 端点;请求 URL 含 appid + secret,**禁止整 URL 入日志 / 错误信息**(E-12)。
export const WECHAT_CODE2SESSION_URL = 'https://api.weixin.qq.com/sns/jscode2session';
// 原生 fetch + AbortSignal.timeout 上限(沿 #346 外部请求 8s 上限先例;零新依赖)
export const WECHAT_REQUEST_TIMEOUT_MS = 8000;

// 微信 errcode → 域错误映射(E-11):仅这两个 errcode 判"code 无效"(40029 invalid js_code /
// 40163 code been used);其余非 0(含 -1 系统繁忙 / 40013 / 40125 / 45011)归 WechatApiError。
export const WECHAT_ERRCODE_CODE_INVALID: ReadonlyArray<number> = [40029, 40163];

// ===== 订阅消息发送(统一通知 S2;评审稿 §3.1)=====
// access_token 取用 stable_token(非 legacy /cgi-bin/token):后者新 token 使旧失效、多调用方互踩;
// stable_token 不互斥(单实例进程内缓存安全)。请求体含 appid + secret,**禁止整 body / URL 入日志**(E-12)。
export const WECHAT_STABLE_TOKEN_URL = 'https://api.weixin.qq.com/cgi-bin/stable_token';
// 订阅消息下发端点;query 含 access_token,**禁止整 URL / access_token 入日志**(E-12,镜像 code2session secret 纪律)。
export const WECHAT_SUBSCRIBE_SEND_URL = 'https://api.weixin.qq.com/cgi-bin/message/subscribe/send';

// access_token 进程内缓存上限(微信 access_token 有效期 7200s;7000s 过期前主动刷新留 200s 余量)。
// 单实例部署前提(沿 wechat 60s settings 缓存 / 生日批 E-B12);多实例横向扩容前须改共享缓存(挂边界条款 R-5/E-B12)。
export const WECHAT_ACCESS_TOKEN_CACHE_MS = 7_000_000;

// 订阅消息发送失败 errcode 语义(评审稿 §3.4):
// - 40001 / 42001:access_token 失效/过期 → 刷 token 重试一次(非业务重试,token 层;WechatService 编排)
export const WECHAT_ERRCODE_TOKEN_INVALID: ReadonlyArray<number> = [40001, 42001];
// - 43101:用户拒收 / 无订阅授权额度 → delivery failed need-resubscribe + 条件回补 quota(派发器据此)
export const WECHAT_ERRCODE_SUBSCRIBE_NO_AUTH = 43101;
// - 40003:openid 非法 → failed invalid-openid(不回补,不重试)
export const WECHAT_ERRCODE_INVALID_OPENID = 40003;
// - 47003:模板参数不匹配 → failed template-param(运维/开发修模板映射,不回补不重试)
export const WECHAT_ERRCODE_TEMPLATE_PARAM = 47003;

// ===== DevStub(E-10)=====
// 非生产联调通道:按 code 返确定性假 openid(e2e 可造多个"微信用户");
// production-like 下 DEV_STUB 写入与运行时双重被禁(镜像 sms E-15),前缀永不出现在生产。
export const WECHAT_DEV_STUB_OPENID_PREFIX = 'dev-openid-';

// ===== openid 掩码(E-13)=====
// 响应(GET me/wechat)与 audit detail 的唯一掩码实现;openid 非 L3 但**不滥回显**:
// 不入 pino 日志 / snapshot 示例,出现处一律先过本函数。
// 防御:长度 ≤ 8 整体打码,不泄露片段(镜像 maskPhone 防御)。
export function maskOpenid(openid: string): string {
  if (openid.length <= 8) {
    return '***';
  }
  return `${openid.slice(0, 4)}****${openid.slice(-4)}`;
}
