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
