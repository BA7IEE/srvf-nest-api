import { Injectable, Logger } from '@nestjs/common';

import type { RealnameOcrInput, RealnameOcrResult, RealnameProvider } from '../realname.types';

// 招新实名环节 OCR 改造(2026-06-22):DevStub OCR Provider(评审稿 E-RO-9)
//
// 非生产联调通道:不调任何外部服务,返**确定性** OCR 识别结果——
// 把上传的证件照 buffer 当作 UTF-8 JSON「OCR 信封」解析回显:
//   { name?, idCardNumber?, warnings?: string[], clarity?: boolean, documentCategory?: string }
// e2e / 本地联调据此造每条链路(大陆自动通过 / 匹配不一致转人工 / 不清晰 / 防伪告警 / 回乡证类别)。
// 解析失败(非 JSON)→ 兜底返「清晰、无告警、空字段」结果(本地随手联调用)。
//
// 与 wechat/sms DevStub 一致:debug 日志**不输出**姓名 / 证件号(高敏感 PII,不入日志);
// 不模拟通道错误 / 超时(真实通道错误映射由 tencent-realname.provider.spec mock 覆盖);
// production-like 下 DEV_STUB 写入与运行时双重被禁(镜像 wechat E-10),本 Provider 生产物理不可达。

interface DevStubOcrEnvelope {
  name?: string;
  idCardNumber?: string;
  warnings?: string[];
  clarity?: boolean;
  documentCategory?: string;
}

@Injectable()
export class DevStubRealnameProvider implements RealnameProvider {
  private readonly logger = new Logger(DevStubRealnameProvider.name);

  recognize(input: RealnameOcrInput): Promise<RealnameOcrResult> {
    this.logger.debug(`[DEV_STUB] realname OCR recognize called type=${input.documentTypeCode}`);
    const env = this.parseEnvelope(input.image);
    if (!env) {
      // 非 JSON 图:兜底确定性结果(清晰、无告警、无字段)——本地随手联调,不用于精确 e2e 断言
      return Promise.resolve({ recognized: true, name: null, idCardNumber: null, warnings: [] });
    }
    const clarity = env.clarity ?? true;
    if (!clarity) {
      return Promise.resolve({
        recognized: false,
        name: null,
        idCardNumber: null,
        warnings: [],
        reason: 'dev-stub: image not clear',
      });
    }
    return Promise.resolve({
      recognized: true,
      name: env.name ?? null,
      idCardNumber: env.idCardNumber ?? null,
      warnings: env.warnings ?? [],
      documentCategory: env.documentCategory ?? null,
    });
  }

  private parseEnvelope(image: Buffer): DevStubOcrEnvelope | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(image.toString('utf8'));
    } catch {
      return null;
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed; // object 结构性满足全可选的 DevStubOcrEnvelope
    }
    return null;
  }
}
