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
  WecomCredentialStatus,
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
// 本文件所有对外可见的字符串只含:固定端点名、errcode、归一化标签、**协议字段名**。
//
// **只按 errcode 分类,不依赖 errmsg**(规则 3)—— errmsg 是上游可随时改的展示文案,
// 拿它做分支等于把业务逻辑挂在别人的文案上。
//
// ⚠️ **本类刻意不 `implements WecomProvider`,也刻意没有任何实例字段**(2026-08-01 W3)。
// 它是 `@Injectable` **单例**:初版 `prepare()` 写 `this.settings` 后 `return this`,
// 于是并发请求互串配置快照 —— 实测两个并发 `resolveRoute()` 之后,请求 A 的路由拿着
// 请求 B 的 CorpID + CorpSecret 去换 token,且两者被 token cache 合并成同一次上游请求
//(red-first 见 `wecom.service.spec.ts` 与 `wecom.provider.spec.ts`)。
// 现在唯一的公开入口是 `prepare(settings): WecomProvider`,返回**绑定不可变 ctx 的新对象**;
// 「未 prepare 就调用」因此是**编译错误**而不是运行时错误。
// 同款范式:`cos.provider` / `wechat.provider` / `tencent-realname.provider`。
// ⚠️ T3 / T5B 加新能力请往 `prepare()` 返回的对象里加 `xxxWithContext(ctx, …)`,
// **不要**给本类补回实例方法或实例字段 —— 那等于把编译期防线降级回运行时。

interface TokenCacheEntry {
  token: string;
  expiresAtMs: number;
  refreshPromise: Promise<string> | null;
}

// 本次请求专属的不可变运行上下文(由 prepare 从 settings snapshot 派生一次,之后只读)。
interface WecomContext {
  corpId: string;
  corpSecret: string;
  agentId: number | null;
  configurationGeneration: string;
}

// 上游回执一律当 `unknown` 处理后逐字段收窄 —— 不给 `any` 开口子。
// 企业微信的响应形状随接口而异,用 `any` 会让"字段名打错"这种错误静默漏到运行时。
type WecomResponseBody = Record<string, unknown>;

// ===== 严格协议解析(2026-08-01 W2)=====
//
// ⚠️ **不得用本地配置或"合理默认值"补上游事实**。
// 初版用 `readNumber(body, key, fallback)` 兜底,三个默认值各自是一句谎话:
//   - `errcode` 缺失 → 0(= **成功**)
//   - `agentid` 缺失 → 填**本地配置的 agentId** ⇒ test-connection 的 agentMatched 恒 true(自己和自己比)
//   - `close`   缺失 → 0(= **应用已启用**)
// 三条叠加的结果是:上游返回 `{}`,诊断接口回答"一切正常"。
// 现在协议字段一律 required,缺失 / 类型不符统一 `INVALID_RESPONSE`(调用方映射 36031)。

/** 抛协议解析失败。detail 只含**字段名与期望类型**,不含上游 body 原文(§7.1 规则 2)。 */
function invalidResponse(endpoint: string, detail: string): never {
  throw new WecomApiError('INVALID_RESPONSE', `${endpoint} 响应字段 ${detail}`);
}

/** 必需整数字段。`typeof === 'number'` 还不够 —— 小数 / NaN / Infinity 都不是合法协议值。 */
function requireInteger(body: WecomResponseBody, key: string, endpoint: string): number {
  const value = body[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    invalidResponse(endpoint, `${key} 缺失或不是整数`);
  }
  return value;
}

/** 必需非空字符串字段。 */
function requireNonEmptyString(body: WecomResponseBody, key: string, endpoint: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value === '') {
    invalidResponse(endpoint, `${key} 缺失或不是非空字符串`);
  }
  return value;
}

/** 可选字符串字段 —— **仅用于不参与任何判据的展示性字段**(如 agent name、msgid)。 */
function readOptionalString(body: WecomResponseBody, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

// 可见范围**只数长度**,ID 一律不取出(§7.1 规则 12:不得穿过 service 边界)。
// 形状为 `{ allow_userinfos: { user: [...] } }` 这类嵌套。
//
// **缺席**与**读不懂**必须区分:
//   - 整个键缺席 → 0。缺席 = 空列表,这是协议读法,不是本地兜底。
//   - 键在但不是对象 / 内层在但不是数组 → INVALID_RESPONSE。
//     静默计 0 会把"读不懂上游回执"报成"没有人可见" —— 这是诊断接口最不该撒的谎。
function countNestedStrict(
  body: WecomResponseBody,
  outerKey: string,
  innerKey: string,
  endpoint: string,
): number {
  const outer = body[outerKey];
  if (outer === undefined || outer === null) return 0;
  if (typeof outer !== 'object' || Array.isArray(outer)) {
    invalidResponse(endpoint, `${outerKey} 不是对象`);
  }
  const inner = (outer as Record<string, unknown>)[innerKey];
  if (inner === undefined || inner === null) return 0;
  if (!Array.isArray(inner)) {
    invalidResponse(endpoint, `${outerKey}.${innerKey} 不是数组`);
  }
  return inner.length;
}

// 进程内 token 缓存(规则 9-11):键 = corpId + agentId + configurationGeneration。
// 多实例各自缓存合法(规则 10):缓存丢失只增加取 token 请求,不影响正确性。
// 模块级而非实例级 —— 键里带 generation,配置一变就自然不命中旧条目(规则 11),无需手动 invalidate。
// ⚠️ 这是**进程级**缓存,不是**请求级**状态:与上面 W3 那条不矛盾,判别标准是"键里带不带 generation"。
const tokenCache = new Map<string, TokenCacheEntry>();

@Injectable()
export class WecomRealProvider {
  private readonly logger = new Logger(WecomRealProvider.name);

  /**
   * 绑定一份 settings snapshot,返回**只服务本次请求**的 route(由 `WecomService.routeFor` 调用)。
   * 返回对象闭包住不可变 ctx,不会再读取任何共享可变状态。
   */
  prepare(settings: WecomSettingsResolved): WecomProvider {
    const ctx = this.requireWecomContext(settings);
    return {
      exchangeOAuthCode: (input) => this.exchangeOAuthCodeWithContext(ctx, input),
      getAccessToken: (forceRefresh, beforeEffect) =>
        this.getAccessTokenWithContext(ctx, forceRefresh, beforeEffect),
      getAgent: (accessToken, agentId, beforeEffect) =>
        this.getAgent(accessToken, agentId, beforeEffect),
      sendTextCard: (accessToken, input, beforeEffect) =>
        this.sendTextCardWithContext(ctx, accessToken, input, beforeEffect),
    };
  }

  // === internals ===

  // 解析 supplied settings snapshot + 4 档守护;**不读取** WecomSettingsService。
  // 这是 WecomService.routeFor 之外的第二道(纵深防御);镜像 wechat requireWechatContext。
  private requireWecomContext(settings: WecomSettingsResolved): WecomContext {
    if (!settings.enabled) {
      throw new WecomChannelUnavailableError('wecom_settings.enabled=false');
    }
    if (settings.providerType !== 'WECOM') {
      throw new WecomChannelUnavailableError(`providerType=${settings.providerType} 不是 WECOM`);
    }
    if (settings.credentialStatus !== WecomCredentialStatus.CONFIGURED || !settings.credentials) {
      throw new WecomChannelUnavailableError(`凭证不可用:${settings.credentialStatus}`);
    }
    if (!settings.corpId) {
      throw new WecomChannelUnavailableError('corpId 缺失');
    }
    return {
      corpId: settings.corpId,
      corpSecret: settings.credentials.corpSecret,
      agentId: settings.agentId,
      configurationGeneration: settings.configurationGeneration,
    };
  }

  private async exchangeOAuthCodeWithContext(
    ctx: WecomContext,
    input: { code: string },
  ): Promise<{ wecomUserId: string }> {
    const accessToken = await this.getAccessTokenWithContext(ctx);
    // code 只出现在 query 中提交给上游;**不入日志、不入 Audit、不落库**(§5.5)
    const body = await this.getJson(
      `${WECOM_GET_USER_INFO_URL}?access_token=${encodeURIComponent(accessToken)}&code=${encodeURIComponent(input.code)}`,
      'auth/getuserinfo',
    );

    const errcode = requireInteger(body, 'errcode', 'auth/getuserinfo');
    if (errcode !== 0) {
      if (WECOM_ERRCODE_OAUTH_INVALID.includes(errcode)) {
        throw new WecomOAuthInvalidError(String(errcode));
      }
      this.throwByErrcode(errcode, 'auth/getuserinfo');
    }

    // 规则 4:必须是**小写** `userid`。
    // 上游对外部联系人返回 `openid`(而非 userid),对互联企业返回 `CorpId/userid` 形式 ——
    // 二者都不是本企业内部成员,§0.3 明确「OAuth 返回 CorpId/userid 形式时第一版统一拒绝」。
    // 这里用 optional 读取而非 requireNonEmptyString:缺 userid 的语义是"这个人不是内部成员"
    // (归 36010 身份类失败),不是"回执畸形"(36031)。
    const userid = readOptionalString(body, 'userid');
    if (userid === null || userid.includes('/')) {
      throw new WecomOAuthInvalidError('NO_INTERNAL_USERID');
    }
    return { wecomUserId: userid };
  }

  private async getAccessTokenWithContext(
    ctx: WecomContext,
    forceRefresh = false,
    beforeEffect?: WecomBeforeEffect,
  ): Promise<string> {
    const cacheKey = `${ctx.corpId}:${ctx.agentId ?? ''}:${ctx.configurationGeneration}`;
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

    const promise = this.fetchAccessToken(ctx, cacheKey, beforeEffect);
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

  private async getAgent(
    accessToken: string,
    agentId: number,
    beforeEffect?: WecomBeforeEffect,
  ): Promise<WecomAgentSnapshot> {
    if (beforeEffect) await beforeEffect();
    const body = await this.getJson(
      `${WECOM_AGENT_GET_URL}?access_token=${encodeURIComponent(accessToken)}&agentid=${agentId}`,
      'agent/get',
    );
    const errcode = requireInteger(body, 'errcode', 'agent/get');
    if (errcode !== 0) {
      this.throwByErrcode(errcode, 'agent/get');
    }
    // 规则 12:可见范围 ID **不得穿过 service 边界** —— 这里当场计数后即弃,
    // 返回类型里根本没有存放 ID 的字段(类型系统兜底,不靠自觉)。
    //
    // ⚠️ `agentid` / `close` 必须来自上游。入参 `agentId` 只用来**拼请求 URL**,
    // 绝不当作回执缺失时的替补值 —— 那会让调用方的 `agent.agentId === agentId` 恒成立。
    return {
      agentId: requireInteger(body, 'agentid', 'agent/get'),
      name: readOptionalString(body, 'name') ?? '',
      close: requireInteger(body, 'close', 'agent/get'),
      allowUserCount: countNestedStrict(body, 'allow_userinfos', 'user', 'agent/get'),
      allowPartyCount: countNestedStrict(body, 'allow_partys', 'partyid', 'agent/get'),
      allowTagCount: countNestedStrict(body, 'allow_tags', 'tagid', 'agent/get'),
    };
  }

  // T5B 才由 Outbox 消费;T2 落形状与错误分类,不接任何调用方。
  private async sendTextCardWithContext(
    ctx: WecomContext,
    accessToken: string,
    input: WecomTextCardInput,
    beforeEffect?: WecomBeforeEffect,
  ): Promise<WecomSendResult> {
    if (beforeEffect) await beforeEffect();
    try {
      const body = await this.postJson(
        `${WECOM_MESSAGE_SEND_URL}?access_token=${encodeURIComponent(accessToken)}`,
        {
          touser: input.toUser,
          msgtype: 'textcard',
          agentid: ctx.agentId,
          textcard: {
            title: input.title,
            description: input.description,
            url: input.url,
            btntxt: input.btnTxt,
          },
        },
        'message/send',
      );
      const errcode = requireInteger(body, 'errcode', 'message/send');
      if (errcode !== 0) {
        return { ok: false, errCode: String(errcode), errMsg: `message/send errcode=${errcode}` };
      }
      // §0.5 第 1 条:invaliduser / unlicenseduser 是**投递诊断**,不得误记为 SENT。
      return {
        ok: true,
        msgId: readOptionalString(body, 'msgid'),
        invalidUsers: this.splitUserList(body.invaliduser),
        unlicensedUsers: this.splitUserList(body.unlicenseduser),
      };
    } catch (err) {
      // 含 requireInteger 抛出的 INVALID_RESPONSE:回执读不懂 ⇒ ok:false,**绝不记为发送成功**
      if (err instanceof WecomApiError) {
        return { ok: false, errCode: err.errCode, errMsg: err.errMsg };
      }
      throw err;
    }
  }

  private async fetchAccessToken(
    ctx: WecomContext,
    cacheKey: string,
    beforeEffect?: WecomBeforeEffect,
  ): Promise<string> {
    if (beforeEffect) await beforeEffect();
    // ⚠️ 本行是全模块唯一携带 corpsecret 的 URL —— 它绝不出现在任何日志或异常里
    const url = `${WECOM_GET_TOKEN_URL}?corpid=${encodeURIComponent(ctx.corpId)}&corpsecret=${encodeURIComponent(ctx.corpSecret)}`;
    const body = await this.getJson(url, 'gettoken');

    const errcode = requireInteger(body, 'errcode', 'gettoken');
    if (errcode !== 0) {
      this.throwByErrcode(errcode, 'gettoken');
    }
    const token = requireNonEmptyString(body, 'access_token', 'gettoken');
    const expiresIn = requireInteger(body, 'expires_in', 'gettoken');
    if (expiresIn <= 0) {
      invalidResponse('gettoken', 'expires_in 必须为正整数');
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

      // 传输层只判「是不是 -1 系统繁忙」,**不做**协议解析(那是端点级 parser 的职责)。
      // 用严格相等而不是带默认值的读取:缺 errcode 显然不等于 -1,不需要也不该编一个默认值。
      const errcode = (body as WecomResponseBody).errcode;
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
