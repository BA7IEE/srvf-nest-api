// 企业微信接入 T2(2026-08-01):模块常量
//
// 冻结稿:docs/archive/reviews/wecom-integration-t0-terminal-review.md(下称"冻结稿")§7.1 / §19.2。
//
// ⚠️ 命名铁律(冻结稿开头):`WeCom`/`wecom` = 企业微信;`Wechat`/`wechat` 专指微信小程序。
// 二者不得混写、混表、混错误码、混通知渠道 —— 本文件与 wechat.constants.ts **刻意不共用任何常量**,
// 连 8000ms 超时这种巧合相同的值也各自声明(共用即产生耦合,一方调参会静默改另一方)。

// ===== 外部协议锚点(冻结稿 §7.1)=====
// 以下 URL 的 query / body 含 corpsecret 或 access_token。
// **禁止**完整 URL、body、fetch error 原文入日志(冻结稿 §7.1 规则 2;镜像 wechat E-12 纪律)。
export const WECOM_GET_TOKEN_URL = 'https://qyapi.weixin.qq.com/cgi-bin/gettoken';
export const WECOM_AGENT_GET_URL = 'https://qyapi.weixin.qq.com/cgi-bin/agent/get';
export const WECOM_GET_USER_INFO_URL = 'https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo';
export const WECOM_MESSAGE_SEND_URL = 'https://qyapi.weixin.qq.com/cgi-bin/message/send';
export const WECOM_OAUTH_AUTHORIZE_URL = 'https://open.weixin.qq.com/connect/oauth2/authorize';

// Node 22 原生 fetch + AbortSignal.timeout(冻结稿 §7.1 规则 1);零新依赖。
export const WECOM_REQUEST_TIMEOUT_MS = 8000;

// ===== errcode 分类(冻结稿 §7.1 规则 4-8)=====
// 只按 `errcode` 分类,**不依赖可能变化的 `errmsg`**(规则 3)。
//
// 规则 5:确定性配置 / 权限错误 → 36030,终态,不自动重试。
// 重试解决不了「Secret 错了」「应用没权限」「IP 不在白名单」—— 重试只是把同一个错误打上游 N 次。
export const WECOM_ERRCODE_CONFIG_FATAL: ReadonlyArray<number> = [
  40001, // 不合法的 secret
  40013, // 不合法的 corpid
  40056, // 不合法的 agentid
  50001, // redirect_url 未登记可信域名
  50003, // 应用已过期
  60020, // 访问 IP 不在白名单
  60031, // 应用不可见
  301002, // 无权限操作指定用户
  48001, // 接口未授权
  48002, // API 禁用
];

// 规则 6:token 失效 —— **仅允许**强制刷新 access token 并重试原请求 **一次**;
// 再次失败即 token-failed。禁止刷新循环(否则一次配置错误会变成对上游的持续打点)。
export const WECOM_ERRCODE_TOKEN_INVALID: ReadonlyArray<number> = [40014, 42001];

// 规则 4:OAuth code / 身份类失败 → 统一 36010(公开面归一,防侧写:
// 不区分「code 无效」与「这个人没绑定」,否则登录接口就成了账号存在性探测器)。
export const WECOM_ERRCODE_OAUTH_INVALID: ReadonlyArray<number> = [40029, 42003, 42022];

// 规则 7:系统繁忙,最多自动尝试 3 次。
export const WECOM_ERRCODE_SYSTEM_BUSY = -1;
export const WECOM_SYSTEM_BUSY_MAX_ATTEMPTS = 3;

// 规则 8:限流。**不做秒级 / 指数盲重试** —— 官方拦截窗口内重试只会延长拦截;
// intent 终态 dead/rate-limited,由运维在窗口结束后显式 replay。
export const WECOM_ERRCODE_RATE_LIMITED = 45009;

// ===== 类型化错误分类(外部评审 F2 / B7,2026-08-03)=====
//
// **为什么必须存在**:第一版把 Provider 的失败压成一个 `errCode: string`,调用方再靠
// 字符串嗅探(`errCode === 'FETCH_ERROR' || …`)决定退避与否。两处当场失真:
//   - `throwByErrcode(45009)` 抛的 errCode 是归一化标签 `'RATE_LIMITED'`,
//     而 Outbox 侧用 `Number(errCode)` 比对 45009 —— `NaN`,**限流被读成"其它上游失败"**;
//   - HTTP 4xx 与 5xx 共用同一个 `'HTTP_ERROR'` 标签 —— 确定性错误被当成暂态,退避 8 次才 dead。
//
// 现在 **errCode 与 kind 分成两根轴**,各自只回答一件事:
//   - `errCode` = **上游说了什么**(原始 errcode 数字,或网络/协议层的归一化标签)。
//     它进 `NotificationDelivery.errCode` 与安全日志,是诊断用的事实。
//   - `kind`    = **这意味着什么**(下面这个闭集)。它是**唯一**的重试 / 终态判据。
//
// ⚠️ 判据只认 `kind`。任何"再按 errCode 字符串补一刀"的写法都是把擦除重新引回来 ——
// 分类必须只发生一次,就在 Provider 里,靠近它唯一知道真相的地方。
export const WECOM_ERROR_KIND = {
  /** 45009 官方限流。窗口内重试**只会延长拦截** ⇒ 终态 dead,等人工 replay。 */
  RATE_LIMITED: 'rate-limited',
  /** 确定性配置 / 权限错(见 WECOM_ERRCODE_CONFIG_FATAL)。重试解决不了"Secret 错了"。 */
  CONFIG_FATAL: 'config-fatal',
  /** HTTP 4xx —— 确定性请求错,重试无意义(与 5xx **必须**分开)。 */
  HTTP_4XX: 'http-4xx',
  /** HTTP 5xx —— 上游侧暂态,可退避。 */
  HTTP_5XX: 'http-5xx',
  /** 连接失败 / DNS / 对端断开等网络错,可退避。 */
  NETWORK: 'network',
  /** 请求超时,可退避(与 network 同退避语义,但诊断信号不同,不合并)。 */
  TIMEOUT: 'timeout',
  /** 回执缺协议字段 / 类型不符 / 非 JSON —— 读不懂就不下结论,不退避。 */
  INVALID_RESPONSE: 'invalid-response',
  /** 40014 / 42001 access_token 失效 —— 允许强刷一次后重试一次。 */
  TOKEN_INVALID: 'token-invalid',
  /** 通道不可用(未配置 / 总闸关 / 凭证缺失或无效 / production-like 下 DEV_STUB)。 */
  CHANNEL_DISABLED: 'channel-disabled',
  /** -1 系统繁忙 —— 上游自己说的"稍后再试",与 5xx 同类,可退避。 */
  SYSTEM_BUSY: 'system-busy',
  /** 其余非 0 errcode:上游明确拒绝了这次调用,但不属于上面任何一类。不退避。 */
  UPSTREAM_REJECTED: 'upstream-rejected',
  /**
   * 请求契约错:单 touser 请求却收到 `invalidparty` / `invalidtag`(§10.7 第 5 条)。
   * 发出去的请求根本不是我们以为的那个 —— 重发同一个坏请求一万次也还是坏的。
   * 与 `http-4xx` 处置相同(终态 dead 等人接手),但诊断信号完全不同,不合并。
   */
  PROVIDER_CONTRACT: 'provider-contract',
} as const;
export type WecomErrorKind = (typeof WECOM_ERROR_KIND)[keyof typeof WECOM_ERROR_KIND];

/**
 * errcode → kind(**唯一**分类点;规则 4-8 的执行位)。
 *
 * `40029/42003/42022` 这组 OAuth 身份类失败不经过这里 —— 它们在 `exchangeOAuthCode`
 * 内部先被拦成 `WecomOAuthInvalidError`(§11.2 归 36010,防账号存在性侧写)。
 */
export function classifyWecomErrcode(errcode: number): WecomErrorKind {
  if (errcode === WECOM_ERRCODE_RATE_LIMITED) return WECOM_ERROR_KIND.RATE_LIMITED;
  if (errcode === WECOM_ERRCODE_SYSTEM_BUSY) return WECOM_ERROR_KIND.SYSTEM_BUSY;
  if (WECOM_ERRCODE_TOKEN_INVALID.includes(errcode)) return WECOM_ERROR_KIND.TOKEN_INVALID;
  if (WECOM_ERRCODE_CONFIG_FATAL.includes(errcode)) return WECOM_ERROR_KIND.CONFIG_FATAL;
  return WECOM_ERROR_KIND.UPSTREAM_REJECTED;
}

// ===== 物理尝试预算(外部评审 F2 / B6)=====
//
// `message/send` 的传输层**不自己重试**:退避与放弃归 Outbox 一家。
//
// 修复前预算不贯通:Provider 内部对 5xx / -1 / 网络错重试 3 次,`deliverWecom` 因
// token-invalid 再走一遍完整 `send()`,Outbox 再退避 8 次 ⇒ 一条通知最多 **48 次**
// 物理 message/send。企业微信侧 1800s 重复检查是第二层保险,不是打点许可证。
//
// 现在:每个 Outbox attempt 内 message/send 物理次数 ≤ 2(首发 + 强刷 token 后重试一次),
// 全局上限 = 8 个 attempt × 2 = 16,且每一次都紧前过 fence。
//
// ⚠️ gettoken / agent/get / auth/getuserinfo **不在此列**,仍用 WECOM_SYSTEM_BUSY_MAX_ATTEMPTS:
// 它们不产生用户可见 Effect,且登录链路没有 Outbox 兜底 —— 一起砍掉等于改 T3 的行为。
export const WECOM_MESSAGE_SEND_MAX_ATTEMPTS = 1;

// ===== access token 缓存(冻结稿 §7.1 规则 9-11)=====
// 有效期以上游返回的 `expires_in` 为准;这里只是提前刷新的安全缓冲。
// 缓存键 = corpId + agentId + configurationGeneration ⇒ 配置一变,新 generation 不命中旧 token(规则 11)。
export const WECOM_ACCESS_TOKEN_REFRESH_BUFFER_MS = 200_000;

// ===== DevStub(冻结稿 §7.2)=====
// code → `dev-wecom-${sha256(code).slice(0,24)}`,确定性生成;code 本身不进返回 / 日志 / Audit。
export const WECOM_DEV_STUB_USER_ID_PREFIX = 'dev-wecom-';
export const WECOM_DEV_STUB_USER_ID_HASH_LENGTH = 24;

// ===== 掩码(冻结稿 §5.5 数据分级)=====
// wecomUserId 是 L2 稳定身份标识:业务**必须明文存储**用于发送,
// 但所有响应、Audit 和日志**只允许掩码**。出现处一律先过本函数。
// 防御:长度 ≤ 8 整体打码,不泄露片段(镜像 maskOpenid / maskPhone 同款防御)。
export function maskWecomUserId(wecomUserId: string): string {
  if (wecomUserId.length <= 8) {
    return '***';
  }
  return `${wecomUserId.slice(0, 4)}****${wecomUserId.slice(-4)}`;
}

// corpId 属"内部配置"级:明文存储,settings 响应**掩码回显**,Audit 不写 value(§5.5)。
export function maskCorpId(corpId: string): string {
  if (corpId.length <= 8) {
    return '***';
  }
  return `${corpId.slice(0, 4)}****${corpId.slice(-4)}`;
}

// ===== T3(2026-08-02):OAuth state / binding ticket / returnPath(冻结稿 §5.3 / §6.2)=====

// §5.3 规则 5:state 固定 randomBytes(32).toString('hex')
// = 64 个 ASCII 字母数字字符、256-bit 熵、≤128 字节,满足官方 `[a-zA-Z0-9]` 字符集要求。
// **不要**改成 base64url:那会引入 `-` / `_`,超出官方声明的字符集。
export const WECOM_OAUTH_STATE_BYTES = 32;
export const WECOM_OAUTH_STATE_HEX_LENGTH = WECOM_OAUTH_STATE_BYTES * 2;
export const WECOM_OAUTH_STATE_TTL_MS = 5 * 60 * 1000;

// §5.3 规则 6:binding ticket 默认 10 分钟。ticket 保持"内部 opaque 随机",
// 不承诺字符集(它只在本系统内往返,不进任何第三方 URL)。
export const WECOM_BINDING_TICKET_BYTES = 32;
export const WECOM_BINDING_TICKET_TTL_MS = 10 * 60 * 1000;

// §6.2 规则 2:code 非空且 UTF-8 字节数 ≤512。**按字节判**不是按字符 ——
// 长度检查的目的是挡住畸形超长入参打到上游,而 UTF-8 多字节字符会让 `.length` 低估实际体积。
export const WECOM_OAUTH_CODE_MAX_BYTES = 512;

// §6.2:redirect_uri 指向**固定**前端 GET callback 页面。
// 这个 path 由代码固定拼接、不可配置 —— `webBaseUrl` 只允许 origin(见 wecom-settings.service
// isValidWebBaseUrl)正是为了这条:允许配置里带 path,配置面就成了改回跳目标的入口。
export const WECOM_OAUTH_CALLBACK_PATH = '/auth/wecom/callback';

// 默认 returnPath(§6.2:login 走前台首页;bind_self 走账号安全页)
export const WECOM_DEFAULT_LOGIN_RETURN_PATH = '/';
export const WECOM_DEFAULT_BIND_SELF_RETURN_PATH = '/me/security';

// returnPath 上限:超长一律拒(它要原样存进 attempt 行,且随后会进浏览器地址栏)
export const WECOM_RETURN_PATH_MAX_LENGTH = 512;

// §6.2:query 中的 token-like key 一律拒。
// 为什么:returnPath 会被前端在登录成功后直接跳转,凭证类参数跟着回跳 =
// 把一次性凭证写进浏览器历史 / Referer / 埋点。**宁可误杀**站内正常参数,
// 也不给"凭证搭便车"留口子(客户端遇拒改用无凭证的 path 即可)。
const WECOM_RETURN_PATH_TOKEN_LIKE_WORDS: ReadonlySet<string> = new Set([
  'token',
  'secret',
  'password',
  'passwd',
  'pwd',
  'code',
  'state',
  'ticket',
  'key',
  'apikey',
  'apisecret',
  'auth',
  'session',
  'sid',
  'sig',
  'signature',
  'jwt',
  'credential',
  'assertion',
]);

/**
 * query key 是否 token-like(**逐段精确**匹配,不是子串包含)。
 *
 * 判据演进的两次实测(都写在这儿,免得后来者把它"简化"回去):
 * - 初版是带分隔符的正则 `^(.*[_-])?(token|…)([_-].*)?$`,**漏掉 camelCase**:
 *   `refreshToken` 里 `refresh` 后面没有 `_`/`-`,整条不匹配 → 凭证直接放行。
 * - 若改成纯子串包含,又会误杀 `keyword`(含 `key`)这类正常参数。
 *
 * 现在的做法:先按 camelCase 边界与所有非字母数字字符切段,再要求**某一段完整等于**
 * 词表里的词。于是 `refreshToken` / `access_token` / `Access-Token` 全中,`keyword` 不中。
 *
 * ⚠️ 已知且**接受**的误杀:`sortKey` / `groupKey` 这类会被切出 `key` 段而被拒。
 * 凭证参数漏过去的代价(一次性凭证进浏览器历史)远大于前端改个参数名的代价。
 */
function isTokenLikeQueryKey(key: string): boolean {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter((segment) => segment !== '')
    .some((segment) => WECOM_RETURN_PATH_TOKEN_LIKE_WORDS.has(segment.toLowerCase()));
}

// 控制字符 + 空格 + DEL(§6.2 明文点名的 control chars)。
//
// ⚠️ 用**数值比较**而不是正则字符类,是刻意的:字符类写法要么把真实控制字节敲进
// 源文件(本刀初版这么干过一次 —— `grep FORBIDDEN` 零命中,因为 grep 把整个文件
// 当二进制了,整段在评审和 diff 里直接不可见),要么依赖转义在各层工具链里原样存活。
// 数值比较两样都不沾,且判据一眼可读。
//
// 阈值:code <= 0x20 覆盖全部 C0 控制字符**与空格**(空格 / Tab 会被部分代理和浏览器
// 吞掉,吞掉后 path 语义就变了);0x7F 是 DEL。
function hasForbiddenReturnPathChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * returnPath 站内相对路径判定(冻结稿 §6.2;**开放重定向的唯一防线**)。
 *
 * 逐条对应冻结稿列出的拒绝项:
 * - `http:` / `https:` / 任意 scheme —— 由"必须以单个 `/` 开头"整体挡掉
 * - `//` 协议相对 —— 显式拒(`//evil.com` 在浏览器里是**外站**)
 * - `\` 反斜杠 —— 显式拒(浏览器把 `/\evil.com` 规范化成 `//evil.com`)
 * - control chars —— 显式拒
 * - 用户名密码片段 —— 拒 `@`(`/@evil.com` 经某些客户端拼接后会变成 userinfo)
 * - query 中的 token-like key —— 逐 key 正则拒
 *
 * 三道判据是**递进**而不是重复:字符级黑名单挡已知写法;百分号解码后复跑一遍挡
 * `/%2F%2Fevil.com` 这类编码绕过;最后 `new URL(raw, base)` 做语义级复核 ——
 * 归一化后仍必须落在同一 origin。前两道挡的是想到的写法,第三道挡没想到的。
 */
export function isSafeWecomReturnPath(raw: string): boolean {
  if (typeof raw !== 'string') return false;
  if (raw === '' || raw.length > WECOM_RETURN_PATH_MAX_LENGTH) return false;
  if (hasForbiddenReturnPathChar(raw)) return false;
  if (raw.includes('\\') || raw.includes('@')) return false;
  if (!raw.startsWith('/') || raw.startsWith('//')) return false;

  // 百分号编码复核:`/%2F%2Fevil.com` 解码后是 `//evil.com`。
  // 解码失败(畸形 `%` 序列)同样拒 —— 读不懂就不放行。
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return false;
  }
  if (hasForbiddenReturnPathChar(decoded)) return false;
  if (decoded.includes('\\') || decoded.includes('@')) return false;
  if (!decoded.startsWith('/') || decoded.startsWith('//')) return false;

  // 语义级复核:base 用一个**不可能解析成真实站点**的 origin(`.invalid` 是 RFC 2606 保留后缀),
  // 归一化后 origin 没变才算"站内"。
  const base = 'https://wecom-return-path.invalid';
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return false;
  }
  if (url.origin !== base) return false;
  if (!url.pathname.startsWith('/')) return false;

  for (const key of url.searchParams.keys()) {
    if (isTokenLikeQueryKey(key)) return false;
  }
  return true;
}

/**
 * 企业微信网页授权 URL(冻结稿 §6.2,参数顺序与形态**逐字冻结**)。
 *
 * `appid=CORPID` · `redirect_uri=encodeURIComponent(FIXED_CALLBACK_URL)` · `response_type=code`
 * · `scope=snsapi_base` · `state=STATE` · `agentid=AGENTID` · `#wechat_redirect`
 *
 * ⚠️ 手工拼串而不是 `URLSearchParams`:后者对 `:` `/` 的编码策略与 `encodeURIComponent`
 * 不一致,会让 redirect_uri 的编码结果"看起来对但和企业微信后台登记的不一样"。
 * 冻结稿明确要求 **只编码一次**,手工拼是唯一能逐字复核的写法。
 *
 * `scope=snsapi_base` 是 D-WC-13:静默授权,只换 userid,不弹授权页、不取昵称头像。
 * `agentid` 必带(D-WC-13):不带时企业微信换出的 userid 归属不可控。
 */
export function buildWecomAuthorizeUrl(input: {
  corpId: string;
  agentId: number;
  webBaseUrl: string;
  state: string;
}): string {
  // webBaseUrl 已由 settings 写入口保证为 origin(无 path / query / fragment);
  // 这里仍去掉可能的结尾斜杠,避免拼出 `https://x//auth/wecom/callback`。
  const origin = input.webBaseUrl.replace(/\/+$/, '');
  const redirectUri = `${origin}${WECOM_OAUTH_CALLBACK_PATH}`;
  return (
    `${WECOM_OAUTH_AUTHORIZE_URL}` +
    `?appid=${encodeURIComponent(input.corpId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=snsapi_base` +
    `&state=${encodeURIComponent(input.state)}` +
    `&agentid=${encodeURIComponent(String(input.agentId))}` +
    `#wechat_redirect`
  );
}

/** §6.2 规则 2:code 的 UTF-8 字节数上限校验(非空 + ≤512 字节)。 */
export function isAcceptableWecomOAuthCode(code: string): boolean {
  if (typeof code !== 'string' || code === '') return false;
  return Buffer.byteLength(code, 'utf8') <= WECOM_OAUTH_CODE_MAX_BYTES;
}
