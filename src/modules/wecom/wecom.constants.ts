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
