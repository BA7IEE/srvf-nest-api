import { Injectable, Logger } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';

import { RealnameSettingsService } from '../realname-settings.service';
import {
  REALNAME_REQUEST_TIMEOUT_MS,
  REALNAME_TC_ACTION,
  REALNAME_TC_DEFAULT_REGION,
  REALNAME_TC_ENDPOINT,
  REALNAME_TC_HOST,
  REALNAME_TC_RESULT_MATCHED,
  REALNAME_TC_SERVICE,
  REALNAME_TC_SIGN_ALGORITHM,
  REALNAME_TC_VERSION,
} from '../realname.constants';
import {
  RealnameApiError,
  RealnameChannelUnavailableError,
  RealnameCredentialStatus,
  type RealnameProvider,
  type RealnameVerifyInput,
  type RealnameVerifyResult,
} from '../realname.types';

// 招新一期 · 实名核验通道 T2(2026-06-18):真实腾讯云 Provider(评审稿 E-R-5;**休眠**待运维)
//
// 产品 = 慧眼 faceid IdCardVerification(姓名 + 身份证号二要素核验)。结构镜像 wechat.provider:
// - secretId / secretKey / region 从 RealnameSettingsService.getActiveSettings() 读(60s 缓存;不依赖 env)
// - 每次调用 requireTencentContext() 做 4 档守护(settings null·未启用 / providerType ≠ TENCENT_CLOUD /
//   credentialStatus ≠ CONFIGURED;region 缺省兜底)
// - 传输层 = **原生 fetch + TC3-HMAC-SHA256 签名**(node crypto;零新依赖,沿 wechat E-2「不引 SDK」+
//   #346 外部请求 8s 上限);**真通道休眠**:DevStub 全验,本 Provider 仅由 .spec mock fetch 锁结构。
//
// 结果语义(评审稿 types):Response.Result='0' → matched;其余 → mismatch(报名状态机走 rejected,
// **不是异常**)。上游失败(Error 回执 / HTTP 非 200 / 超时 / 网络 / 缺 Result)→ RealnameApiError(27031)。
//
// 安全性(评审稿 §6,L3 红线):
// - secretKey 仅参与签名计算,**不入**日志 / 错误信息 / 请求体;Authorization 头不落日志
// - 姓名 / 身份证号在请求体中明文(API 必需),但**不入日志**(失败仅记 err.name / status / Tencent Code)

// 腾讯云 v3 统一回执(Response 包裹;成功含 Result,失败含 Error)
interface TencentIdCardVerifyWireResponse {
  Response?: {
    Result?: string;
    Description?: string;
    RequestId?: string;
    Error?: { Code?: string; Message?: string };
  };
}

@Injectable()
export class TencentRealnameProvider implements RealnameProvider {
  private readonly logger = new Logger(TencentRealnameProvider.name);

  constructor(private readonly settings: RealnameSettingsService) {}

  async verify(input: RealnameVerifyInput): Promise<RealnameVerifyResult> {
    const ctx = await this.requireTencentContext();
    const payload = JSON.stringify({ IdCard: input.idCardNumber, Name: input.name });
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = this.buildSignedHeaders(ctx, payload, timestamp);

    let res: Response;
    try {
      res = await fetch(REALNAME_TC_ENDPOINT, {
        method: 'POST',
        headers,
        body: payload,
        signal: AbortSignal.timeout(REALNAME_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // 超时(TimeoutError)/ DNS / 连接失败;仅取 err.name(错误原文可能内嵌敏感上下文)
      const name = err instanceof Error ? err.name : 'UnknownError';
      this.logger.warn(`realname verify fetch failed name=${name}`);
      throw new RealnameApiError('FETCH_ERROR', name);
    }

    if (!res.ok) {
      this.logger.warn(`realname verify http error status=${res.status}`);
      throw new RealnameApiError('HTTP_ERROR', `status=${res.status}`);
    }

    let raw: string;
    try {
      raw = await res.text();
    } catch (err) {
      const name = err instanceof Error ? err.name : 'UnknownError';
      this.logger.warn(`realname verify body read failed name=${name}`);
      throw new RealnameApiError('FETCH_ERROR', name);
    }

    let body: TencentIdCardVerifyWireResponse;
    try {
      body = JSON.parse(raw) as TencentIdCardVerifyWireResponse;
    } catch {
      this.logger.warn('realname verify invalid response: non-JSON body');
      throw new RealnameApiError('INVALID_RESPONSE', 'non-JSON body');
    }

    const response = body.Response;
    if (!response) {
      this.logger.warn('realname verify invalid response: missing Response envelope');
      throw new RealnameApiError('INVALID_RESPONSE', 'missing Response');
    }

    if (response.Error) {
      // 腾讯云 Error.Code / Message 来自回执,不含 secret;可入日志辅助运维定位
      const code = response.Error.Code ?? 'UNKNOWN';
      this.logger.warn(`realname verify tencent error code=${code}`);
      throw new RealnameApiError(code, response.Error.Message ?? 'unknown tencent error');
    }

    if (response.Result === undefined) {
      this.logger.warn('realname verify response has no Result');
      throw new RealnameApiError('MISSING_RESULT', 'response has no Result');
    }

    // Result='0' 二要素一致 → matched;其余结果码 → mismatch(Description 作归一化原因)
    if (response.Result === REALNAME_TC_RESULT_MATCHED) {
      return { matched: true };
    }
    return { matched: false, reason: response.Description ?? `result=${response.Result}` };
  }

  // 解析 settings + 4 档守护(镜像 wechat requireWechatContext;
  // 第 1/2 档在 RealnameVerificationService.resolve 已挡,此处防御性重查)
  private async requireTencentContext(): Promise<{
    secretId: string;
    secretKey: string;
    region: string;
  }> {
    const settings = await this.settings.getActiveSettings();
    if (!settings || !settings.enabled) {
      throw new RealnameChannelUnavailableError('realname_verification_settings 未配置或未启用');
    }
    if (settings.providerType !== 'TENCENT_CLOUD') {
      throw new RealnameChannelUnavailableError(
        `providerType=${settings.providerType} 不是 TENCENT_CLOUD`,
      );
    }
    if (
      settings.credentialStatus !== RealnameCredentialStatus.CONFIGURED ||
      !settings.credentials
    ) {
      throw new RealnameChannelUnavailableError(`credentialStatus=${settings.credentialStatus}`);
    }
    return {
      secretId: settings.credentials.secretId,
      secretKey: settings.credentials.secretKey,
      region: settings.region ?? REALNAME_TC_DEFAULT_REGION,
    };
  }

  // 腾讯云 API v3 TC3-HMAC-SHA256 签名(node crypto;零新依赖)。
  // 返回完整请求头;secretKey 仅在 HMAC 链内使用,不外泄。
  private buildSignedHeaders(
    ctx: { secretId: string; secretKey: string; region: string },
    payload: string,
    timestampSec: number,
  ): Record<string, string> {
    const date = new Date(timestampSec * 1000).toISOString().slice(0, 10); // UTC YYYY-MM-DD
    const actionLower = REALNAME_TC_ACTION.toLowerCase();

    // 1. canonical request
    const canonicalHeaders =
      `content-type:application/json; charset=utf-8\n` +
      `host:${REALNAME_TC_HOST}\n` +
      `x-tc-action:${actionLower}\n`;
    const signedHeaders = 'content-type;host;x-tc-action';
    const hashedPayload = sha256hex(payload);
    const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, hashedPayload].join(
      '\n',
    );

    // 2. string to sign
    const credentialScope = `${date}/${REALNAME_TC_SERVICE}/tc3_request`;
    const stringToSign = [
      REALNAME_TC_SIGN_ALGORITHM,
      String(timestampSec),
      credentialScope,
      sha256hex(canonicalRequest),
    ].join('\n');

    // 3. signature(HMAC 链)
    const secretDate = hmac256(Buffer.from(`TC3${ctx.secretKey}`, 'utf8'), date);
    const secretService = hmac256(secretDate, REALNAME_TC_SERVICE);
    const secretSigning = hmac256(secretService, 'tc3_request');
    const signature = hmac256(secretSigning, stringToSign).toString('hex');

    // 4. authorization
    const authorization =
      `${REALNAME_TC_SIGN_ALGORITHM} ` +
      `Credential=${ctx.secretId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, ` +
      `Signature=${signature}`;

    return {
      Authorization: authorization,
      'Content-Type': 'application/json; charset=utf-8',
      Host: REALNAME_TC_HOST,
      'X-TC-Action': REALNAME_TC_ACTION,
      'X-TC-Timestamp': String(timestampSec),
      'X-TC-Version': REALNAME_TC_VERSION,
      'X-TC-Region': ctx.region,
    };
  }
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function hmac256(key: Buffer, input: string): Buffer {
  return createHmac('sha256', key).update(input, 'utf8').digest();
}
