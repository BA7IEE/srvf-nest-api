import type { CookieOptions, Request, Response } from 'express';

import { WECOM_OAUTH_STATE_TTL_MS } from '../wecom/wecom.constants';

// 企业微信 OAuth —— 浏览器关联 nonce 的 Cookie 层(P1-27 第一刀 B1,2026-08-03)
//
// ── 修的是什么 ──
// T3 原实现里,`state` 只证明"这条 OAuth 回跳对应我方签发过的一次 attempt",
// **不证明"提交回跳的浏览器就是发起授权的那个浏览器"**。于是:
//   攻击者在自己那侧走完企业微信授权拿到 `code + state`,再把它塞进受害者的浏览器
//   (一个页面、一条链接就够),受害者浏览器提交 → 服务端签出的是**攻击者身份**的会话。
//   若攻击者的企业微信身份尚未绑定任何账号,受害者会在自己页面上看到"请输入手机号 + 短信码",
//   照做之后**攻击者的企业微信身份被绑到受害者账号** —— 登录 CSRF 升级为完整账号接管。
//   ⚠️ 这条不是推演:2026-08-03 的一次性取证探针在**未修代码**上端到端跑通过,
//      落库终态就是 `wecom_identities(wecomUserId=攻击者, userId=受害者, status=active)`。
//
// ── 怎么修 ──
// authorize 时另发一份**浏览器关联 nonce**:原值只走 `Secure + HttpOnly + SameSite` Cookie,
// 台账侧只留它的 hash;callback 必须同时携带匹配 Cookie 才算数。
// 攻击者拿得到 `state`(它经企业微信重定向暴露在 URL / Referer / 网关日志里),
// 但拿不到受害者浏览器上的 Cookie,也无法把自己那份 Cookie 写进受害者浏览器
// (`__Host-` 前缀:host-only、必须 Secure、必须 `Path=/`、不得带 `Domain`,
// 同站子域也投不进来)。
//
// ⚠️ 原值**只**能落在 Cookie 里。冻结稿 §5.5 与前后端交接层明禁把 code / state / nonce
//    放进 localStorage / sessionStorage —— 那等于把 HttpOnly 白给回去。
// ⚠️ 本文件不碰 DB、不碰上游。nonce ↔ state 的派生与一次性消费在
//    `wecom/wecom-auth-attempt.service.ts`(通道层台账的唯一写入点),
//    这里只负责"怎么把原值安全地交给浏览器、怎么把它读回来"。

/**
 * 两条流程各自一个 Cookie 名 —— 刻意**不共用**。
 *
 * 共用会让"同一浏览器里同时开着登录流程和登录态换绑流程"互相覆盖:
 * 后发起的把先发起的 nonce 冲掉,先发起的那条回来时莫名其妙 36010。
 * 两条流程的 purpose 在台账层本来就是隔离的(§14.1),Cookie 层照抄同一条边界。
 *
 * `__Host-` 前缀不是装饰:浏览器强制要求该前缀的 Cookie 必须 `Secure`、必须 `Path=/`、
 * 不得带 `Domain` —— 于是"哪天有人把 Secure 去掉"这类回归会被**浏览器**当场拒收,
 * 而不是安静地降级成一个可被同站子域投毒的 Cookie。执行位在浏览器,不在自觉。
 */
export const WECOM_LOGIN_NONCE_COOKIE = '__Host-srvf_wecom_login';
export const WECOM_BIND_NONCE_COOKIE = '__Host-srvf_wecom_bind';

export type WecomNonceCookieName = typeof WECOM_LOGIN_NONCE_COOKIE | typeof WECOM_BIND_NONCE_COOKIE;

/**
 * Cookie 属性。
 *
 * - `httpOnly`:脚本读不到 ⇒ XSS 拿不走它,也堵死"图省事塞 localStorage"的退路
 * - `secure`:**恒 true**,不按环境开关。这是登录 CSRF 的防线;
 *   "本地 http 调试方便"不足以换一个按配置生效的安全属性 —— 生产上错配没有任何断言会红。
 *   (`__Host-` 前缀本身也强制这一条,两道各自独立。)
 * - `sameSite: 'lax'`:跨站 POST / XHR 一律不带此 Cookie;跨站顶层 GET 导航
 *   (企业微信 → 回跳页)带,正是回跳页加载所需要的那一次。
 *   不用 `strict` 的原因不是安全性 —— 是它对"回跳页由跨站导航抵达"这一步的浏览器差异更多,
 *   而真正的防线是 nonce 比对本身,`SameSite` 只是纵深。
 * - `path: '/'` + 无 `domain`:`__Host-` 前缀的强制项。
 */
const WECOM_NONCE_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
};

/** 下发浏览器关联 nonce;有效期与 OAuth state 同寿(不会出现"一半还有效"的中间态)。 */
export function setWecomBrowserNonceCookie(
  res: Response,
  name: WecomNonceCookieName,
  browserNonce: string,
): void {
  res.cookie(name, browserNonce, {
    ...WECOM_NONCE_COOKIE_OPTIONS,
    maxAge: WECOM_OAUTH_STATE_TTL_MS,
  });
}

/**
 * 消费后清 Cookie。
 *
 * 成功失败都清:对应的 state 无论如何都已经不可能再被这条 nonce 用掉
 * (成功 = 已消费;失败 = 这个浏览器本来就不持有能配上它的那份),
 * 留在浏览器里只会在下一次流程里制造"用错那份 nonce"的可能。
 */
export function clearWecomBrowserNonceCookie(res: Response, name: WecomNonceCookieName): void {
  res.clearCookie(name, WECOM_NONCE_COOKIE_OPTIONS);
}

/**
 * 从请求头里读回 nonce 原值。
 *
 * 刻意**手工解析 `req.headers.cookie`** 而不引入 cookie-parser:
 * 本仓这条链路只需要读一个固定名字的 Cookie,为它加一个全局中间件会让
 * `req.cookies` 出现在所有 controller 的可达面上(迟早有人顺手拿它当会话来源)。
 * 零新依赖也与本模块既有纪律一致(通道层用原生 fetch,不引 SDK)。
 *
 * 返回 `null` 的三种情形(缺头 / 没这个名字 / 值为空)对调用方**同形**:
 * 它们最终都走同一个 36010 出口,不区分子原因。
 */
export function readWecomBrowserNonce(req: Request, name: WecomNonceCookieName): string | null {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length === 0) return null;

  for (const segment of header.split(';')) {
    const separator = segment.indexOf('=');
    if (separator <= 0) continue;
    if (segment.slice(0, separator).trim() !== name) continue;

    const raw = segment.slice(separator + 1).trim();
    if (raw.length === 0) return null;
    // 值本身是 hex,不需要解码;但 express 写出去时会按需编码,
    // 这里对称地解一次,免得将来改了 nonce 编码就静默失配。
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  return null;
}
