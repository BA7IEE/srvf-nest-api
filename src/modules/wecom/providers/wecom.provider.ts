import { Injectable, Logger } from '@nestjs/common';

import {
  WECOM_ACCESS_TOKEN_REFRESH_BUFFER_MS,
  WECOM_AGENT_GET_URL,
  WECOM_ERRCODE_CONFIG_FATAL,
  WECOM_ERRCODE_OAUTH_INVALID,
  WECOM_ERRCODE_RATE_LIMITED,
  WECOM_ERRCODE_SYSTEM_BUSY,
  WECOM_GET_TOKEN_URL,
  WECOM_GET_USER_INFO_URL,
  WECOM_MESSAGE_SEND_URL,
  WECOM_REQUEST_TIMEOUT_MS,
  WECOM_SYSTEM_BUSY_MAX_ATTEMPTS,
} from '../wecom.constants';
import {
  WecomApiError,
  WecomChannelUnavailableError,
  WecomOAuthInvalidError,
  type WecomAgentSnapshot,
  type WecomBeforeEffect,
  type WecomProvider,
  type WecomSendResult,
  type WecomSettingsResolved,
  type WecomTextCardInput,
} from '../wecom.types';

// 企业微信接入 T2(2026-08-01):真实企业微信 Provider(冻结稿 §7.1)
//
// ⚠️ **日志纪律**(§7.1 规则 2,本文件最硬的一条):
// gettoken 的 corpsecret 在 **query string** 里,message/send 与 agent/get 的 access_token
// 同样在 query 里。因此:
//   - 禁止把完整 URL 写进日志 / 错误信息 / 异常 message
//   - 禁止把 fetch 的原始 error 直接抛出(Node fetch 的 TypeError.cause 会带上完整 URL)
//   - 禁止把上游 body 原文写进日志
// 本文件所有对外可见的字符串只含:固定端点名、errcode、归一化标签。
//
// **只按 errcode 分类,不依赖 errmsg**(规则 3)—— errmsg 是上游可随时改的展示文案,
// 拿它做分支等于把业务逻辑挂在别人的文案上。
//
// 短生命周期实例:`prepare(settings)` 绑定一份 settings snapshot 后返回自身,
// 镜像 WechatMiniRealProvider.prepare 范式(每次 resolve 读一次 DB,不做长驻缓存)。

interface TokenCacheEntry {
  token: string;
  expiresAtMs: number;
  refreshPromise: Promise<string> | null;
}

// 上游回执一律当 `unknown` 处理后逐字段收窄 —— 不给 `any` 开口子。
// 企业微信的响应形状随接口而异,用 `any` 会让"字段名打错"这种错误静默漏到运行时。
type WecomResponseBody = Record<string, unknown>;

function readString(body: WecomResponseBody, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function readNumber(body: WecomResponseBody, key: string, fallback: number): number {
  const value = body[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// 可见范围**只数长度**,ID 一律不取出(§7.1 规则 12:不得穿过 service 边界)。
// 形状为 `{ allow_userinfos: { user: [...] } }` 这类嵌套;任一层缺失即计 0。
function countNested(body: WecomResponseBody, outerKey: string, innerKey: string): number {
  const outer = body[outerKey];
  if (typeof outer !== 'object' || outer === null) return 0;
  const inner = (outer as Record<string, unknown>)[innerKey];
  return Array.isArray(inner) ? inner.length : 0;
}

// 进程内 token 缓存(规则 9-11):键 = corpId + agentId + configurationGeneration。
// 多实例各自缓存合法(规则 10):缓存丢失只增加取 token 请求,不影响正确性。
// 模块级而非实例级 —— prepare() 每次返回的是同一个 @Injectable 单例,但键里带 generation,
// 配置一变就自然不命中旧条目(规则 11),无需手动 invalidate。
const tokenCache = new Map<string, TokenCacheEntry>();

@Injectable()
export class WecomRealProvider implements WecomProvider {
  private readonly logger = new Logger(WecomRealProvider.name);
  private settings: WecomSettingsResolved | null = null;

  /** 绑定一份 settings snapshot(由 WecomService.resolveRoute 调用) */
  prepare(settings: WecomSettingsResolved): WecomProvider {
    this.settings = settings;
    return this;
  }

  async exchangeOAuthCode(input: { code: string }): Promise<{ wecomUserId: string }> {
    const accessToken = await this.getAccessToken();
    // code 只出现在 query 中提交给上游;**不入日志、不入 Audit、不落库**(§5.5)
    const body = await this.getJson(
      `${WECOM_GET_USER_INFO_URL}?access_token=${encodeURIComponent(accessToken)}&code=${encodeURIComponent(input.code)}`,
      'auth/getuserinfo',
    );

    const errcode = readNumber(body, 'errcode', 0);
    if (errcode !== 0) {
      if (WECOM_ERRCODE_OAUTH_INVALID.includes(errcode)) {
        throw new WecomOAuthInvalidError(String(errcode));
      }
      this.throwByErrcode(errcode, 'auth/getuserinfo');
    }

    // 规则 4:必须是**小写** `userid`。
    // 上游对外部联系人返回 `openid`(而非 userid),对互联企业返回 `CorpId/userid` 形式 ——
    // 二者都不是本企业内部成员,§0.3 明确「OAuth 返回 CorpId/userid 形式时第一版统一拒绝」。
    const userid = readString(body, 'userid');
    if (userid === null || userid.includes('/')) {
      throw new WecomOAuthInvalidError('NO_INTERNAL_USERID');
    }
    return { wecomUserId: userid };
  }

  async getAccessToken(forceRefresh = false, beforeEffect?: WecomBeforeEffect): Promise<string> {
    const s = this.requireSettings();
    const corpId = s.corpId;
    const corpSecret = s.credentials?.corpSecret;
    if (!corpId || !corpSecret) {
      throw new WecomChannelUnavailableError('corpId 或 CorpSecret 缺失');
    }
    const cacheKey = `${corpId}:${s.agentId ?? ''}:${s.configurationGeneration}`;
    const now = Date.now();
    const cached = tokenCache.get(cacheKey);

    if (!forceRefresh && cached && cached.expiresAtMs > now) {
      // 命中缓存也要过 beforeEffect —— fence 校验的语义是"每次真正外部请求前",
      // 但这里没有外部请求,故不调用;调用方的 fence 由下游真实请求处再验(规则 13)。
      return cached.token;
    }
    // refreshPromise 合并并发刷新(规则 9):N 个并发调用只打上游一次
    if (!forceRefresh && cached?.refreshPromise) {
      return cached.refreshPromise;
    }

    const promise = this.fetchAccessToken(corpId, corpSecret, cacheKey, beforeEffect);
    tokenCache.set(cacheKey, {
      token: cached?.token ?? '',
      expiresAtMs: cached?.expiresAtMs ?? 0,
      refreshPromise: promise,
    });
    try {
      return await promise;
    } finally {
      const entry = tokenCache.get(cacheKey);
      if (entry?.refreshPromise === promise) {
        entry.refreshPromise = null;
      }
    }
  }

  async getAgent(
    accessToken: string,
    agentId: number,
    beforeEffect?: WecomBeforeEffect,
  ): Promise<WecomAgentSnapshot> {
    if (beforeEffect) await beforeEffect();
    const body = await this.getJson(
      `${WECOM_AGENT_GET_URL}?access_token=${encodeURIComponent(accessToken)}&agentid=${agentId}`,
      'agent/get',
    );
    const errcode = readNumber(body, 'errcode', 0);
    if (errcode !== 0) {
      this.throwByErrcode(errcode, 'agent/get');
    }
    // 规则 12:可见范围 ID **不得穿过 service 边界** —— 这里当场计数后即弃,
    // 返回类型里根本没有存放 ID 的字段(类型系统兜底,不靠自觉)。
    return {
      agentId: readNumber(body, 'agentid', agentId),
      name: readString(body, 'name') ?? '',
      close: readNumber(body, 'close', 0),
      allowUserCount: countNested(body, 'allow_userinfos', 'user'),
      allowPartyCount: countNested(body, 'allow_partys', 'partyid'),
      allowTagCount: countNested(body, 'allow_tags', 'tagid'),
    };
  }

  // T5B 才由 Outbox 消费;T2 落形状与错误分类,不接任何调用方。
  async sendTextCard(
    accessToken: string,
    input: WecomTextCardInput,
    beforeEffect?: WecomBeforeEffect,
  ): Promise<WecomSendResult> {
    const s = this.requireSettings();
    if (beforeEffect) await beforeEffect();
    try {
      const body = await this.postJson(
        `${WECOM_MESSAGE_SEND_URL}?access_token=${encodeURIComponent(accessToken)}`,
        {
          touser: input.toUser,
          msgtype: 'textcard',
          agentid: s.agentId,
          textcard: {
            title: input.title,
            description: input.description,
            url: input.url,
            btntxt: input.btnTxt,
          },
        },
        'message/send',
      );
      const errcode = readNumber(body, 'errcode', 0);
      if (errcode !== 0) {
        return { ok: false, errCode: String(errcode), errMsg: `message/send errcode=${errcode}` };
      }
      // §0.5 第 1 条:invaliduser / unlicenseduser 是**投递诊断**,不得误记为 SENT。
      return {
        ok: true,
        msgId: readString(body, 'msgid'),
        invalidUsers: this.splitUserList(body.invaliduser),
        unlicensedUsers: this.splitUserList(body.unlicenseduser),
      };
    } catch (err) {
      if (err instanceof WecomApiError) {
        return { ok: false, errCode: err.errCode, errMsg: err.errMsg };
      }
      throw err;
    }
  }

  // === internals ===

  private requireSettings(): WecomSettingsResolved {
    if (this.settings === null) {
      throw new WecomChannelUnavailableError('provider 未 prepare(settings snapshot 缺失)');
    }
    return this.settings;
  }

  private async fetchAccessToken(
    corpId: string,
    corpSecret: string,
    cacheKey: string,
    beforeEffect?: WecomBeforeEffect,
  ): Promise<string> {
    if (beforeEffect) await beforeEffect();
    // ⚠️ 本行是全模块唯一携带 corpsecret 的 URL —— 它绝不出现在任何日志或异常里
    const url = `${WECOM_GET_TOKEN_URL}?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`;
    const body = await this.getJson(url, 'gettoken');

    const errcode = readNumber(body, 'errcode', 0);
    if (errcode !== 0) {
      this.throwByErrcode(errcode, 'gettoken');
    }
    const token = readString(body, 'access_token');
    const expiresIn = readNumber(body, 'expires_in', 0);
    if (token === null || expiresIn <= 0) {
      throw new WecomApiError('INVALID_RESPONSE', 'gettoken 响应缺 access_token 或 expires_in');
    }
    // 规则 9:有效期以上游 expires_in 为准,并留安全缓冲提前刷新
    const ttlMs = Math.max(expiresIn * 1000 - WECOM_ACCESS_TOKEN_REFRESH_BUFFER_MS, 1000);
    tokenCache.set(cacheKey, {
      token,
      expiresAtMs: Date.now() + ttlMs,
      refreshPromise: null,
    });
    return token;
  }

  // errcode → 域错误(规则 4-8)。调用方再映射成 BizCode。
  private throwByErrcode(errcode: number, endpoint: string): never {
    if (WECOM_ERRCODE_CONFIG_FATAL.includes(errcode)) {
      // 规则 5:确定性配置 / 权限错误 —— 终态,不自动重试(重试解决不了配置错)
      throw new WecomChannelUnavailableError(`${endpoint} errcode=${errcode}`);
    }
    if (errcode === WECOM_ERRCODE_RATE_LIMITED) {
      // 规则 8:限流 —— 不做盲重试,由运维在官方拦截窗口结束后显式 replay
      throw new WecomApiError('RATE_LIMITED', `${endpoint} errcode=${errcode}`);
    }
    if (errcode === WECOM_ERRCODE_SYSTEM_BUSY) {
      throw new WecomApiError('SYSTEM_BUSY', `${endpoint} errcode=${errcode}`);
    }
    throw new WecomApiError(String(errcode), `${endpoint} errcode=${errcode}`);
  }

  private async getJson(url: string, endpoint: string): Promise<WecomResponseBody> {
    return this.request(url, { method: 'GET' }, endpoint);
  }

  private async postJson(
    url: string,
    payload: unknown,
    endpoint: string,
  ): Promise<WecomResponseBody> {
    return this.request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
      endpoint,
    );
  }

  // 规则 7:`-1` 系统繁忙最多自动尝试 3 次;网络 / 超时 / HTTP 5xx 同批。
  // 规则 3:HTTP 非 2xx、非 JSON、缺协议字段一律 fail-closed。
  private async request(
    url: string,
    init: RequestInit,
    endpoint: string,
  ): Promise<WecomResponseBody> {
    let lastError: WecomApiError | null = null;

    for (let attempt = 1; attempt <= WECOM_SYSTEM_BUSY_MAX_ATTEMPTS; attempt += 1) {
      let res: Response;
      try {
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(WECOM_REQUEST_TIMEOUT_MS) });
      } catch (err) {
        // ⚠️ 绝不冒泡原始 error:Node fetch 的 TypeError.cause 会带完整 URL(含 corpsecret)。
        // 只保留归一化标签与错误**名**。
        const label =
          err instanceof Error && err.name === 'TimeoutError' ? 'TIMEOUT' : 'FETCH_ERROR';
        lastError = new WecomApiError(label, `${endpoint} ${label}`);
        this.logger.warn(`wecom ${endpoint} ${label} (attempt ${attempt})`);
        continue;
      }

      if (res.status >= 500) {
        lastError = new WecomApiError('HTTP_ERROR', `${endpoint} http=${res.status}`);
        this.logger.warn(`wecom ${endpoint} http=${res.status} (attempt ${attempt})`);
        continue;
      }
      if (!res.ok) {
        // 4xx 是确定性错误,重试无意义
        throw new WecomApiError('HTTP_ERROR', `${endpoint} http=${res.status}`);
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new WecomApiError('INVALID_RESPONSE', `${endpoint} 响应非 JSON`);
      }
      if (typeof body !== 'object' || body === null) {
        throw new WecomApiError('INVALID_RESPONSE', `${endpoint} 响应不是对象`);
      }

      const errcode = readNumber(body as WecomResponseBody, 'errcode', 0);
      if (errcode === WECOM_ERRCODE_SYSTEM_BUSY && attempt < WECOM_SYSTEM_BUSY_MAX_ATTEMPTS) {
        lastError = new WecomApiError('SYSTEM_BUSY', `${endpoint} errcode=-1`);
        this.logger.warn(`wecom ${endpoint} errcode=-1 系统繁忙 (attempt ${attempt})`);
        continue;
      }
      return body as WecomResponseBody;
    }

    throw lastError ?? new WecomApiError('FETCH_ERROR', `${endpoint} 重试耗尽`);
  }

  // 上游把多个 userid 用 '|' 连接;空串表示没有
  private splitUserList(raw: unknown): string[] {
    if (typeof raw !== 'string' || raw === '') return [];
    return raw.split('|').filter((v) => v !== '');
  }
}
