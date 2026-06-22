import { Injectable, Logger } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';

import { RealnameSettingsService } from '../realname-settings.service';
import {
  REALNAME_OCR_ACTION_MAINLAND_ID,
  REALNAME_OCR_ACTION_PASSPORT,
  REALNAME_REQUEST_TIMEOUT_MS,
  REALNAME_TC_DEFAULT_REGION,
  REALNAME_TC_ENDPOINT,
  REALNAME_TC_HOST,
  REALNAME_TC_SERVICE,
  REALNAME_TC_SIGN_ALGORITHM,
  REALNAME_TC_VERSION,
  ocrActionFor,
} from '../realname.constants';
import {
  RealnameApiError,
  RealnameChannelUnavailableError,
  RealnameCredentialStatus,
  type RealnameOcrInput,
  type RealnameOcrResult,
  type RealnameProvider,
} from '../realname.types';

// 招新实名环节 OCR 改造(2026-06-22):真实腾讯云 OCR Provider(评审稿 E-RO-2;**休眠**待运维)
//
// 产品 = 腾讯云 OCR(ocr.tencentcloudapi.com,Version 2018-11-19,service ocr),按 documentTypeCode
// 分流三 action(RecognizeValidIDCardOCR / MLIDPassportOCR / MainlandPermitOCR)。结构镜像原 provider:
// - secretId / secretKey / region 从 RealnameSettingsService.getActiveSettings() 读(60s 缓存;不依赖 env)
// - 每次调用 requireTencentContext() 做守护(settings null·未启用 / providerType ≠ TENCENT_CLOUD /
//   credentialStatus ≠ CONFIGURED;region 缺省兜底)
// - 传输层 = **原生 fetch + TC3-HMAC-SHA256 签名**(node crypto;零新依赖,沿 #346 8s 上限);
//   **真通道休眠**:DevStub 全验,本 Provider 仅由 .spec mock fetch 锁三 action 结构。
//
// 结果语义(评审稿 §3.6):返结构化字段 + 防伪告警 + 清晰度(recognized);**是否匹配/放行由调用方裁断**。
// - recognized=false(证件照不清晰 / 关键字段缺)→ 正常结果(驱动 manual_review),**不是异常**。
// - 上游失败(Error 回执 / HTTP 非 200 / 超时 / 网络 / 非 JSON)→ RealnameApiError(27031)。
//
// 安全性(评审稿 §6,L3 红线):
// - secretKey 仅参与签名计算,**不入**日志 / 错误信息 / 请求体;Authorization 头不落日志
// - 证件照 base64 / 姓名 / 证件号在请求体或响应中,但**不入日志**(失败仅记 err.name / status / Tencent Code)
//
// 字段映射:真实字段名以腾讯云 OCR 文档为准,rollout 期对照校正(休眠期由 .spec mock 锁结构)。

// 腾讯云 v3 统一回执(Response 包裹;成功含识别字段,失败含 Error)。三 action 字段并集,均可选。
interface TencentOcrWireResponse {
  Response?: {
    // 通用 / 身份证(RecognizeValidIDCardOCR)
    Name?: string;
    IdNum?: string;
    CardNum?: string;
    WarnInfos?: Array<number | string>; // 防伪/质量告警码(空/缺 = 无告警)
    WarnCardInfos?: Array<number | string>;
    // 护照(MLIDPassportOCR)
    EnglishName?: string;
    ID?: string;
    LicenseNumber?: string;
    // 港澳台来往内地/大陆通行证(MainlandPermitOCR)
    Number?: string;
    CardType?: string; // 证件类别(须 ∈ 来往内地/大陆)
    RequestId?: string;
    Error?: { Code?: string; Message?: string };
  };
}

@Injectable()
export class TencentRealnameProvider implements RealnameProvider {
  private readonly logger = new Logger(TencentRealnameProvider.name);

  constructor(private readonly settings: RealnameSettingsService) {}

  async recognize(input: RealnameOcrInput): Promise<RealnameOcrResult> {
    const action = ocrActionFor(input.documentTypeCode);
    if (!action) {
      // 防御:调用方应只对 OCR 类型调本 provider(isOcrDocument 前置);非 OCR 类型不该到这
      throw new RealnameChannelUnavailableError(
        `documentTypeCode=${input.documentTypeCode} 非 OCR 证件类型`,
      );
    }
    const ctx = await this.requireTencentContext();
    const payload = JSON.stringify({ ImageBase64: input.image.toString('base64') });
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = this.buildSignedHeaders(ctx, payload, timestamp, action);

    let res: Response;
    try {
      res = await fetch(REALNAME_TC_ENDPOINT, {
        method: 'POST',
        headers,
        body: payload,
        signal: AbortSignal.timeout(REALNAME_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : 'UnknownError';
      this.logger.warn(`realname ocr fetch failed action=${action} name=${name}`);
      throw new RealnameApiError('FETCH_ERROR', name);
    }

    if (!res.ok) {
      this.logger.warn(`realname ocr http error action=${action} status=${res.status}`);
      throw new RealnameApiError('HTTP_ERROR', `status=${res.status}`);
    }

    let raw: string;
    try {
      raw = await res.text();
    } catch (err) {
      const name = err instanceof Error ? err.name : 'UnknownError';
      this.logger.warn(`realname ocr body read failed action=${action} name=${name}`);
      throw new RealnameApiError('FETCH_ERROR', name);
    }

    let body: TencentOcrWireResponse;
    try {
      body = JSON.parse(raw) as TencentOcrWireResponse;
    } catch {
      this.logger.warn('realname ocr invalid response: non-JSON body');
      throw new RealnameApiError('INVALID_RESPONSE', 'non-JSON body');
    }

    const response = body.Response;
    if (!response) {
      this.logger.warn('realname ocr invalid response: missing Response envelope');
      throw new RealnameApiError('INVALID_RESPONSE', 'missing Response');
    }

    if (response.Error) {
      // 腾讯云 Error.Code / Message 来自回执,不含 secret;可入日志辅助运维定位
      const code = response.Error.Code ?? 'UNKNOWN';
      this.logger.warn(`realname ocr tencent error action=${action} code=${code}`);
      throw new RealnameApiError(code, response.Error.Message ?? 'unknown tencent error');
    }

    return this.mapResponse(action, response);
  }

  // 三 action 响应 → 归一化 RealnameOcrResult(字段并集;缺关键字段 = recognized:false 不清晰)
  private mapResponse(
    action: string,
    r: NonNullable<TencentOcrWireResponse['Response']>,
  ): RealnameOcrResult {
    if (action === REALNAME_OCR_ACTION_MAINLAND_ID) {
      const name = r.Name ?? null;
      const idCardNumber = r.IdNum ?? r.CardNum ?? null;
      const warnings = [...(r.WarnInfos ?? []), ...(r.WarnCardInfos ?? [])].map((w) => String(w));
      return {
        recognized: Boolean(name && idCardNumber),
        name,
        idCardNumber,
        warnings,
        reason: name && idCardNumber ? undefined : 'id-card key fields missing',
      };
    }
    if (action === REALNAME_OCR_ACTION_PASSPORT) {
      const name = r.Name ?? r.EnglishName ?? null;
      const idCardNumber = r.ID ?? r.LicenseNumber ?? null;
      return {
        recognized: Boolean(name && idCardNumber),
        name,
        idCardNumber,
        warnings: [],
        reason: name && idCardNumber ? undefined : 'passport not machine-readable',
      };
    }
    // REALNAME_OCR_ACTION_HK_MACAU
    const name = r.Name ?? null;
    const idCardNumber = r.Number ?? null;
    return {
      recognized: Boolean(name && idCardNumber),
      name,
      idCardNumber,
      warnings: [],
      documentCategory: r.CardType ?? null,
      reason: name && idCardNumber ? undefined : 'permit key fields missing',
    };
  }

  // 解析 settings + 守护(镜像原 requireTencentContext;
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

  // 腾讯云 API v3 TC3-HMAC-SHA256 签名(node crypto;零新依赖)。action 按调用类型传入。
  // 返回完整请求头;secretKey 仅在 HMAC 链内使用,不外泄。
  private buildSignedHeaders(
    ctx: { secretId: string; secretKey: string; region: string },
    payload: string,
    timestampSec: number,
    action: string,
  ): Record<string, string> {
    const date = new Date(timestampSec * 1000).toISOString().slice(0, 10); // UTC YYYY-MM-DD
    const actionLower = action.toLowerCase();

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
      'X-TC-Action': action,
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
