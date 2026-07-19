import { Injectable, Logger } from '@nestjs/common';

import { WechatSettingsService } from '../wechat-settings.service';
import {
  WECHAT_ACCESS_TOKEN_CACHE_MS,
  WECHAT_CODE2SESSION_URL,
  WECHAT_ERRCODE_CODE_INVALID,
  WECHAT_REQUEST_TIMEOUT_MS,
  WECHAT_STABLE_TOKEN_URL,
  WECHAT_SUBSCRIBE_SEND_URL,
  maskOpenid,
} from '../wechat.constants';
import {
  WechatApiError,
  WechatChannelUnavailableError,
  WechatCodeInvalidError,
  WechatCredentialStatus,
  type Code2SessionInput,
  type Code2SessionResult,
  type SendSubscribeMessageInput,
  type SendSubscribeMessageResult,
  type WechatBeforeEffect,
  type WechatMiniProvider,
} from '../wechat.types';

// 微信小程序登录 T2(2026-06-12):真实微信 Provider(评审稿 E-2/E-11/E-12;
// 结构镜像 tencent-sms.provider,传输层差异 = 原生 fetch 替代 SDK,零新依赖)
//
// - appId / appSecret 从 WechatSettingsService.getActiveSettings() 读(60s 缓存;不依赖 env)
// - 每次调用 requireWechatContext() 做 4 档守护(镜像 requireTencentContext):
//   settings null·未启用 / providerType ≠ WECHAT / credentialStatus ≠ CONFIGURED / appId 缺失
// - 原生 fetch + AbortSignal.timeout 8s(沿 #346 外部请求超时上限先例;Node 22 全局可用)
// - errcode 映射(E-11):40029 / 40163 → WechatCodeInvalidError(25010);
//   其余非 0 errcode / HTTP 非 200 / 超时 / 网络错误 / 缺 openid → WechatApiError(25031)
//
// 安全性(E-12,L3 红线):
// - 请求 URL query 含 appid + secret:**禁止**把 URL / fetch 错误原文写入日志或错误信息
//   (fetch 失败仅取 err.name;HTTP 失败仅取 status;微信 errcode/errmsg 本身不含 secret)
// - session_key / unionid 解析即弃:不入返回类型、不入变量外传、不入日志
//
// 可观测性(2026-06-12 增量 review 发现①⑨收口):全部失败路径各记一行 warn
// (仅 err.name / status / 固定标签,与上述 E-12 纪律兼容)——否则微信侧全挂时
// 服务端零可区分信号,ops SOP 排错表承诺的 FETCH_ERROR / TimeoutError 日志无从看起。

// 微信 jscode2session 回执形状(官方文档;errcode 成功时缺省或为 0)
interface Code2SessionWireResponse {
  openid?: string;
  session_key?: string;
  unionid?: string;
  errcode?: number;
  errmsg?: string;
}

// stable_token 回执形状(成功:access_token + expires_in;失败:errcode + errmsg)
interface StableTokenWireResponse {
  access_token?: string;
  expires_in?: number;
  errcode?: number;
  errmsg?: string;
}

// 订阅消息下发回执形状(成功:errcode=0 + msgid;失败:errcode + errmsg)
interface SubscribeSendWireResponse {
  errcode?: number;
  errmsg?: string;
  msgid?: number | string;
}

@Injectable()
export class WechatMiniRealProvider implements WechatMiniProvider {
  private readonly logger = new Logger(WechatMiniRealProvider.name);

  // access_token 进程内缓存(单实例前提;~7000s,沿 WECHAT_ACCESS_TOKEN_CACHE_MS)。
  // **永不入日志 / 出参 / audit**(L3,镜像 appSecret 纪律)。
  private accessTokenCache: { token: string; expiresAt: number } | null = null;

  constructor(private readonly settings: WechatSettingsService) {}

  async code2session(input: Code2SessionInput): Promise<Code2SessionResult> {
    const ctx = await this.requireWechatContext();

    const url = new URL(WECHAT_CODE2SESSION_URL);
    url.searchParams.set('appid', ctx.appId);
    url.searchParams.set('secret', ctx.appSecret);
    url.searchParams.set('js_code', input.code);
    url.searchParams.set('grant_type', 'authorization_code');

    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(WECHAT_REQUEST_TIMEOUT_MS) });
    } catch (err) {
      // 超时(TimeoutError)/ DNS / 连接失败;仅取 err.name——错误原文可能内嵌完整 URL(含 secret)
      const name = err instanceof Error ? err.name : 'UnknownError';
      this.logger.warn(`wechat code2session fetch failed name=${name}`);
      throw new WechatApiError('FETCH_ERROR', name);
    }

    if (!res.ok) {
      this.logger.warn(`wechat code2session http error status=${res.status}`);
      throw new WechatApiError('HTTP_ERROR', `status=${res.status}`);
    }

    // 微信可能以 text/plain 返回 JSON 体;统一 text → JSON.parse。
    // body 读取与 JSON 解析分开 catch:读取阶段超时 / 连接中断属传输层故障,
    // 归 FETCH_ERROR(原一并落 INVALID_RESPONSE,诊断标签失真)
    let raw: string;
    try {
      raw = await res.text();
    } catch (err) {
      const name = err instanceof Error ? err.name : 'UnknownError';
      this.logger.warn(`wechat code2session body read failed name=${name}`);
      throw new WechatApiError('FETCH_ERROR', name);
    }
    let body: Code2SessionWireResponse;
    try {
      body = JSON.parse(raw) as Code2SessionWireResponse;
    } catch {
      // 响应原文不入日志(内容不可信);固定标签足够区分
      this.logger.warn('wechat code2session invalid response: non-JSON body');
      throw new WechatApiError('INVALID_RESPONSE', 'non-JSON body');
    }

    if (typeof body.errcode === 'number' && body.errcode !== 0) {
      if (WECHAT_ERRCODE_CODE_INVALID.includes(body.errcode)) {
        throw new WechatCodeInvalidError(String(body.errcode));
      }
      // -1 系统繁忙 / 40013 invalid appid / 40125 invalid secret / 45011 频率限制 等;
      // errmsg 来自微信回执,不含 secret,可入错误与日志辅助运维定位
      this.logger.warn(`wechat code2session errcode=${body.errcode} errmsg=${body.errmsg ?? ''}`);
      throw new WechatApiError(String(body.errcode), body.errmsg ?? 'unknown wechat error');
    }

    if (!body.openid) {
      this.logger.warn('wechat code2session response has no openid');
      throw new WechatApiError('MISSING_OPENID', 'response has no openid');
    }

    // session_key / unionid 即弃(E-12):只取 openid 返回
    return { openid: body.openid };
  }

  // ===== 统一通知 S2:订阅消息发送能力(净新建,镜像 code2session 传输层 + E-12 纪律)=====

  /**
   * 取 access_token(stable_token;进程内缓存 ~7000s,单实例前提)。
   * forceRefresh=true → 跳过缓存强刷(token 失效 40001/42001 重试场景)。
   * 失败抛 WechatApiError / WechatChannelUnavailableError(调用方 WechatService catch 归一)。
   * E-12:请求体含 appid + secret;**禁止 body / URL / access_token 入日志**。
   */
  async getAccessToken(forceRefresh = false, beforeEffect?: WechatBeforeEffect): Promise<string> {
    if (!forceRefresh && this.accessTokenCache && this.accessTokenCache.expiresAt > Date.now()) {
      return this.accessTokenCache.token;
    }
    const ctx = await this.requireWechatContext();
    // Context/settings 已准备完成后才重验 fence；guard rejection 不是 provider 失败，
    // 必须留在 fetch catch 外按原值冒泡，且 fetch 绝不能启动。
    if (beforeEffect) await beforeEffect();

    let res: Response;
    try {
      res = await fetch(WECHAT_STABLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'client_credential',
          appid: ctx.appId,
          secret: ctx.appSecret,
          force_refresh: forceRefresh,
        }),
        signal: AbortSignal.timeout(WECHAT_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : 'UnknownError';
      this.logger.warn(`wechat stable_token fetch failed name=${name}`);
      throw new WechatApiError('FETCH_ERROR', name);
    }

    if (!res.ok) {
      this.logger.warn(`wechat stable_token http error status=${res.status}`);
      throw new WechatApiError('HTTP_ERROR', `status=${res.status}`);
    }

    let body: StableTokenWireResponse;
    try {
      body = (await res.json()) as StableTokenWireResponse;
    } catch {
      this.logger.warn('wechat stable_token invalid response: non-JSON body');
      throw new WechatApiError('INVALID_RESPONSE', 'non-JSON body');
    }

    if (typeof body.errcode === 'number' && body.errcode !== 0) {
      // errmsg 来自微信回执,不含 secret;access_token 缺失同归 API 失败
      this.logger.warn(`wechat stable_token errcode=${body.errcode}`);
      throw new WechatApiError(String(body.errcode), body.errmsg ?? 'stable_token failed');
    }
    if (!body.access_token) {
      this.logger.warn('wechat stable_token response has no access_token');
      throw new WechatApiError('MISSING_TOKEN', 'response has no access_token');
    }

    this.accessTokenCache = {
      token: body.access_token,
      expiresAt: Date.now() + WECHAT_ACCESS_TOKEN_CACHE_MS,
    };
    return body.access_token;
  }

  /**
   * 下发订阅消息(单次 POST,不重试、不管理 token——access_token 由调用方 WechatService 传入并编排重试)。
   * 结果归一为 SendSubscribeMessageResult(**不抛业务异常**:网络/HTTP/超时/非 0 errcode 一律 ok:false)。
   * E-12:URL query 含 access_token,**禁止整 URL 入日志**;失败仅记 errcode + maskOpenid。
   */
  async sendSubscribeMessage(
    accessToken: string,
    input: SendSubscribeMessageInput,
    beforeEffect?: WechatBeforeEffect,
  ): Promise<SendSubscribeMessageResult> {
    const url = new URL(WECHAT_SUBSCRIBE_SEND_URL);
    url.searchParams.set('access_token', accessToken);
    // 每次订阅消息 POST（含 token-invalid 后第二次）都是独立 Effect。
    if (beforeEffect) await beforeEffect();

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          touser: input.openid,
          template_id: input.templateId,
          ...(input.page ? { page: input.page } : {}),
          data: input.data,
        }),
        signal: AbortSignal.timeout(WECHAT_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : 'UnknownError';
      this.logger.warn(`wechat subscribe send fetch failed name=${name}`);
      return { ok: false, errCode: 'FETCH_ERROR', errMsg: name };
    }

    if (!res.ok) {
      this.logger.warn(`wechat subscribe send http error status=${res.status}`);
      return { ok: false, errCode: 'HTTP_ERROR', errMsg: `status=${res.status}` };
    }

    let body: SubscribeSendWireResponse;
    try {
      body = (await res.json()) as SubscribeSendWireResponse;
    } catch {
      this.logger.warn('wechat subscribe send invalid response: non-JSON body');
      return { ok: false, errCode: 'INVALID_RESPONSE', errMsg: 'non-JSON body' };
    }

    if (typeof body.errcode === 'number' && body.errcode !== 0) {
      // errmsg 来自微信回执不含 secret;openid 掩码后才可入日志(E-13)
      this.logger.warn(
        `wechat subscribe send errcode=${body.errcode} openid=${maskOpenid(input.openid)}`,
      );
      return {
        ok: false,
        errCode: String(body.errcode),
        errMsg: body.errmsg ?? 'subscribe send failed',
      };
    }

    return { ok: true, msgId: body.msgid !== undefined ? String(body.msgid) : null };
  }

  // 解析 settings + 4 档守护(镜像 tencent-sms requireTencentContext;
  // 第 1/2 档在 WechatService.resolve 已挡,此处防御性重查)
  private async requireWechatContext(): Promise<{ appId: string; appSecret: string }> {
    const settings = await this.settings.getActiveSettings();
    if (!settings || !settings.enabled) {
      throw new WechatChannelUnavailableError('wechat_settings 未配置或未启用');
    }
    if (settings.providerType !== 'WECHAT') {
      throw new WechatChannelUnavailableError(`providerType=${settings.providerType} 不是 WECHAT`);
    }
    if (settings.credentialStatus !== WechatCredentialStatus.CONFIGURED || !settings.credentials) {
      throw new WechatChannelUnavailableError(`credentialStatus=${settings.credentialStatus}`);
    }
    if (!settings.appId) {
      throw new WechatChannelUnavailableError('wechat_settings.appId 未配置');
    }
    return { appId: settings.appId, appSecret: settings.credentials.appSecret };
  }
}
