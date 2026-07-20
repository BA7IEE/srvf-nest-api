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
  type PreparedRealnameEffect,
  type RealnameOcrCardWarnings,
  type RealnameOcrExtendedFields,
  type RealnameOcrField,
  type RealnameOcrInput,
  type RealnameOcrResult,
  type RealnameProvider,
  type RealnameSettingsResolved,
} from '../realname.types';

// 招新实名环节 OCR 改造(2026-06-22):真实腾讯云 OCR Provider(评审稿 E-RO-2;**休眠**待运维)
//
// 产品 = 腾讯云 OCR(ocr.tencentcloudapi.com,Version 2018-11-19,service ocr),按 documentTypeCode
// 分流三 action(RecognizeValidIDCardOCR / MLIDPassportOCR / MainlandPermitOCR)。结构镜像原 provider:
// - 既有直接 recognize live-read 一次 settings；prepare(settings,input) 绑定 supplied snapshot
// - prepare 时 requireTencentContext() 做守护(settings null·未启用 / providerType ≠ TENCENT_CLOUD /
//   credentialStatus ≠ CONFIGURED;region 缺省兜底)
// - credentials/region/payload 在 prepare 固定；TC3 timestamp/Authorization 在 invoke 紧邻 fetch 生成，
//   避免排队后的 prepared Effect 使用陈旧签名时间
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
// 字段映射(2026-06-29 校正,对照腾讯云线上文档):mainland 鉴伪版 RecognizeValidIDCardOCR 返回 **嵌套**
// Response.IDCardInfo —— 姓名/证件号在 .Name.Content / .IdNum.Content(**非顶层字符串**),WarnInfos 是标志位
// 对象(值=1 命中)。passport / hk_macau 的 action 非嵌套,仍按顶层字符串映射。.spec 以真实嵌套结构锁定。
//
// OCR 鉴伪版充分利用(2026-06-29,评审稿 recruitment-ocr-anti-forgery-enrichment-review.md §3.6):请求体显式
// 带 Enable* 开关(仅 mainland),取回扩展字段(Sex/Nation/Birth/Address/Authority/ValidDate,每项 ContentInfo)+
// 字段级反光/不完整标志 + 顶层 CardImage/PortraitImage 裁剪图 base64 + 顶层 Type。字段名以线上文档为准、运维上线校正。

// 腾讯云 OCR ContentInfo:鉴伪版每个识别字段的形状(值在 .Content,另带置信度 + 字段级质量标志)。
interface TencentContentInfo {
  Content?: string;
  Confidence?: number;
  // 字段级质量标志(鉴伪版;Enable* 后返回;布尔或 0/1,coerce 兜底)。Key* = 关键区域。
  IsReflect?: boolean | number;
  IsInComplete?: boolean | number;
  IsKeyReflect?: boolean | number;
  IsKeyInComplete?: boolean | number;
}

// 鉴伪版 CardWarnInfo:防伪/质量标志位(值=1 命中,0/缺=正常)。
// 仅复印/翻拍/PS 三项属**防伪**(进 antiForgeryWarnings → forgery_warning 高风险路由);
// 边缘/遮挡/模糊属**质量**:读不出即 recognized:false 引导重拍,不当防伪升级(避免把真人申请误判为伪造)。
interface TencentCardWarnInfo {
  CopyCheck?: number; // 1=复印件
  ReshootCheck?: number; // 1=翻拍(屏幕拍摄)
  PSCheck?: number; // 1=PS 篡改痕迹
  BorderCheck?: number; // 1=边缘不完整(质量)
  OcclusionCheck?: number; // 1=遮挡(质量)
  BlurCheck?: number; // 1=模糊(质量)
}

// 鉴伪版身份证识别结果容器(RecognizeValidIDCardOCR 的 Response.IDCardInfo)。
// Name/IdNum 既有;Sex/Nation/Birth/Address/Authority/ValidDate 为充分利用新增扩展字段(Enable* 后返回)。
interface TencentIDCardInfo {
  Name?: TencentContentInfo;
  IdNum?: TencentContentInfo;
  WarnInfos?: TencentCardWarnInfo;
  Sex?: TencentContentInfo;
  Nation?: TencentContentInfo;
  Birth?: TencentContentInfo;
  Address?: TencentContentInfo;
  Authority?: TencentContentInfo;
  ValidDate?: TencentContentInfo;
}

// 腾讯云 v3 统一回执(Response 包裹;成功含识别字段,失败含 Error)。三 action 字段并集,均可选。
interface TencentOcrWireResponse {
  Response?: {
    // 身份证鉴伪版(RecognizeValidIDCardOCR):**嵌套** IDCardInfo,字段值在 .Content
    IDCardInfo?: TencentIDCardInfo;
    // 鉴伪版充分利用:顶层裁剪图 base64(Enable* 后返回)+ 识别证件类型字符串
    CardImage?: string; // 主体框裁剪图 base64(EnableCropImage)
    PortraitImage?: string; // 头像裁剪图 base64(EnablePortrait)
    Type?: string; // 识别出的证件类型
    // 护照(MLIDPassportOCR):顶层字符串字段
    Name?: string;
    EnglishName?: string;
    ID?: string;
    LicenseNumber?: string;
    // 港澳台来往内地/大陆通行证(MainlandPermitOCR):顶层字符串字段
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
    const settings = await this.settings.getActiveSettings();
    return this.prepare(settings, input).invoke();
  }

  prepare(
    settings: RealnameSettingsResolved | null,
    input: RealnameOcrInput,
  ): PreparedRealnameEffect {
    const action = ocrActionFor(input.documentTypeCode);
    if (!action) {
      // 防御:调用方应只对 OCR 类型调本 provider(isOcrDocument 前置);非 OCR 类型不该到这
      throw new RealnameChannelUnavailableError(
        `documentTypeCode=${input.documentTypeCode} 非 OCR 证件类型`,
      );
    }
    const ctx = this.requireTencentContext(settings);
    const payload = JSON.stringify(buildRequestBody(action, input.image));
    return {
      providerType: 'TENCENT_CLOUD',
      invoke: () => this.recognizeWithContext(ctx, action, input, payload),
    };
  }

  private async recognizeWithContext(
    ctx: { secretId: string; secretKey: string; region: string },
    action: string,
    input: RealnameOcrInput,
    payload: string,
  ): Promise<RealnameOcrResult> {
    // Effect 边界：prepared snapshot 只固定配置与 payload；易过期的 TC3 时间/签名必须在
    // invoke 内、最终 fetch 前即时生成，不能在可能排队的 prepare 阶段冻结。
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
      const msg = response.Error.Message ?? 'unknown tencent error';
      this.logger.warn(`realname ocr tencent error action=${action} code=${code} msg=${msg}`);
      throw new RealnameApiError(code, msg);
    }

    const result = this.mapResponse(action, response);
    // dev 安全诊断(logger.debug:生产日志级别默认不输出;**全程无 PII** —— 仅记命中布尔/长度/code,
    // 永不记姓名/证件号明文)。运维联调据此核对:通道/区域/图片是否送达 + 腾讯是否真返回姓名+证件号。
    this.logger.debug(
      `[realname ocr] providerType=TENCENT_CLOUD action=${action} region=${ctx.region} ` +
        `documentType=${input.documentTypeCode} mime=${input.mimeType} bufferLen=${input.image.length} ` +
        `requestId=${response.RequestId ?? '-'} recognized=${result.recognized} ` +
        `nameHit=${result.name != null} idHit=${result.idCardNumber != null} warnings=${result.warnings.length} ` +
        // 鉴伪版充分利用:仅记裁剪图**是否存在**(布尔)+ base64 长度,**永不记 base64 明文 / 字段内容**(L3)
        `cardImage=${result.cardImageBase64 != null} portrait=${result.portraitImageBase64 != null} ` +
        `cardImageLen=${result.cardImageBase64?.length ?? 0} extFields=${result.extendedFields != null}`,
    );
    return result;
  }

  // 三 action 响应 → 归一化 RealnameOcrResult(字段并集;缺关键字段 = recognized:false 不清晰)
  private mapResponse(
    action: string,
    r: NonNullable<TencentOcrWireResponse['Response']>,
  ): RealnameOcrResult {
    if (action === REALNAME_OCR_ACTION_MAINLAND_ID) {
      // 鉴伪版字段嵌在 Response.IDCardInfo,每项是 { Content } 对象(**非顶层字符串**)。
      // 去混淆(评审稿 §3.6 + 本次修复):IDCardInfo 容器整块缺失 = 响应结构不符(action 用错 / 接口改版 /
      // 非证件图被判另类),属「契约/系统错」而非「照片不清晰」→ 抛 RealnameApiError(识别端上浮 27031、
      // 提交端转 ocr_error),**不静默降级成 recognized:false**。容器在、但 Content 读不出关键字段才算真不清晰。
      const info = r.IDCardInfo;
      if (!info) {
        this.logger.warn(
          `realname ocr contract mismatch action=${action} reason=IDCardInfo-missing`,
        );
        throw new RealnameApiError('CONTRACT_MISMATCH', 'IDCardInfo missing in OCR response');
      }
      const name = info.Name?.Content?.trim() || null;
      const idCardNumber = info.IdNum?.Content?.trim() || null;
      const warnings = collectForgeryWarnings(info.WarnInfos);
      return {
        recognized: Boolean(name && idCardNumber),
        name,
        idCardNumber,
        warnings,
        reason: name && idCardNumber ? undefined : 'id-card key fields missing',
        // 鉴伪版充分利用(§3.6 映射表;顾问式,不入判定):扩展字段 + 卡片级告警 + 顶层 Type + 裁剪图 base64。
        documentType: r.Type?.trim() || null,
        extendedFields: mapExtendedFields(info),
        cardWarnings: mapCardWarnings(info.WarnInfos),
        // 裁剪图 base64:仅 submit 路径消费(不进 recognize 响应/日志);缺省/未返 → null。
        cardImageBase64: r.CardImage || null,
        portraitImageBase64: r.PortraitImage || null,
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

  // 解析 supplied settings snapshot + 守护；不读取 RealnameSettingsService。
  private requireTencentContext(settings: RealnameSettingsResolved | null): {
    secretId: string;
    secretKey: string;
    region: string;
  } {
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

// 鉴伪版 WarnInfos(标志位对象)→ 防伪告警名数组(值=1 命中)。
// 仅复印/翻拍/PS 计入防伪(驱动 forgery_warning 高风险复核);边缘/遮挡/模糊属质量,不当防伪(读不出
// 走 recognized:false 重拍,读得出则放行由申请人确认)。映射收窄 = 不把质量问题误升级成「疑似伪造」。
// **行为锁**:此函数语义/收窄不变(本次充分利用只新增 cardWarnings 全集结构,不改本函数)。
function collectForgeryWarnings(w: TencentCardWarnInfo | undefined): string[] {
  if (!w) return [];
  const out: string[] = [];
  if (w.CopyCheck === 1) out.push('CopyCheck');
  if (w.ReshootCheck === 1) out.push('ReshootCheck');
  if (w.PSCheck === 1) out.push('PSCheck');
  return out;
}

// 鉴伪版充分利用:请求体构造。仅 mainland 鉴伪版带 Enable* 开关(取扩展字段 + 裁剪图 + 各检查);
// passport/hk_macau 那两 action 无鉴伪/裁剪能力,维持 { ImageBase64 } 不变(评审稿 §3.6.1 / E5)。
function buildRequestBody(action: string, image: Buffer): Record<string, unknown> {
  const ImageBase64 = image.toString('base64');
  if (action !== REALNAME_OCR_ACTION_MAINLAND_ID) {
    return { ImageBase64 };
  }
  return {
    ImageBase64,
    EnablePortrait: true, // 返回头像裁剪图 PortraitImage
    EnableCropImage: true, // 返回主体框裁剪图 CardImage
    EnableBorderCheck: true, // 边框完整性
    EnableOcclusionCheck: true, // 遮挡
    EnableCopyCheck: true, // 复印件
    EnableReshootCheck: true, // 翻拍
    EnableQualityCheck: true, // 图像质量(反光/模糊等)
  };
}

// 字段级标志 coerce:腾讯返布尔或 0/1;统一为 boolean。reflect/incomplete 各合并关键区域(Key*)与普通标志。
function flag(v: boolean | number | undefined): boolean {
  return v === true || v === 1;
}
function mapField(c: TencentContentInfo | undefined): RealnameOcrField | null {
  if (!c) return null;
  return {
    content: c.Content?.trim() || null,
    reflect: flag(c.IsReflect) || flag(c.IsKeyReflect),
    incomplete: flag(c.IsInComplete) || flag(c.IsKeyInComplete),
  };
}

// 鉴伪版扩展字段集映射(Sex/Nation/Birth/Address/Authority/ValidDate;顾问式,不入判定)。
function mapExtendedFields(info: TencentIDCardInfo): RealnameOcrExtendedFields {
  return {
    sex: mapField(info.Sex),
    nation: mapField(info.Nation),
    birth: mapField(info.Birth),
    address: mapField(info.Address),
    authority: mapField(info.Authority),
    validDate: mapField(info.ValidDate),
  };
}

// WarnInfos 6 标志 → 卡片级质量/防伪告警全集结构(布尔投影;recognize 顾问式回显)。
function mapCardWarnings(w: TencentCardWarnInfo | undefined): RealnameOcrCardWarnings {
  return {
    copy: w?.CopyCheck === 1,
    reshoot: w?.ReshootCheck === 1,
    ps: w?.PSCheck === 1,
    border: w?.BorderCheck === 1,
    occlusion: w?.OcclusionCheck === 1,
    blur: w?.BlurCheck === 1,
  };
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function hmac256(key: Buffer, input: string): Buffer {
  return createHmac('sha256', key).update(input, 'utf8').digest();
}
