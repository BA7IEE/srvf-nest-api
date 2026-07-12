import { Injectable, Logger } from '@nestjs/common';
import COS from 'cos-nodejs-sdk-v5';

import { StorageSettingsService } from '../storage-settings.service';
import { CredentialStatus, type StorageSettingsResolved } from '../storage-settings.types';
import type { StorageProvider } from '../storage.interface';
import type {
  DownloadUrlResult,
  GenerateDownloadUrlInput,
  GenerateUploadUrlInput,
  HeadObjectResult,
  PutObjectInput,
  StorageBody,
  StoredObject,
  UploadUrlResult,
} from '../storage.types';

// V2.x C-7.5 Provider 选型实施 PR #8:CosStorageProvider(沿 F3 + F5 + Q5 + §6.4)
//
// 范围(PR #8):
// - 原始实现 StorageProvider 5 方法,通过 cos-nodejs-sdk-v5 调腾讯云 COS;
//   v0.44.0 finding #23 追加 ranged getObject 固定前缀 readObjectPrefix
// - 凭证 + bucket + region 从 StorageSettingsService.getActiveSettings() 读(沿 Q23 不依赖 env)
// - 每次方法调用 requireCosContext():settings 60s 缓存削减 DB 压力(沿 PR #87)
// - 4 档守护:settings null / providerType ≠ COS / credentialStatus ≠ CONFIGURED / bucket+region 缺失
//
// **本 PR 不做**:
// - 不接通 attachments.service(留 PR #9 wire `accessUrl` + delete)
// - 不映射 metadata 到 COS x-cos-meta-*(沿 Q-89-3 拍板 B;留 v1.1+)
// - 不实施 multipart upload(沿 Q13)
// - 不使用 STS(沿 Q19)
// - 不缓存 COS 客户端(沿 Q-89-2 拍板 A;每次方法调用新建,SDK 实例轻量)
//
// 安全性:
// - 错误信息不暴露 SecretId / SecretKey 明文 / 密文(沿 §6.6 Q22)
// - credentialStatus 三档守护(沿 §6.6.3)

// 外部 SDK 请求超时上限(2026-06-12 goal G3):COS SDK `Timeout` 单位 ms,默认不设
// (= 无超时),网络黑洞会拖死上游调用方(putObject / headObject 在附件上传确认链路上)。
// 超时由 SDK 抛错,沿既有错误路径透出,语义不变。当前真实 COS 未接通(运维侧未录入
// 凭证),本配置"正确但休眠":unit spec 锁构造参数就位,真连后的端到端超时行为留运维
// 接力时验证。
const COS_REQUEST_TIMEOUT_MS = 8000;

export class CosProviderUnavailableError extends Error {
  constructor(reason: string) {
    super(`COS_PROVIDER_UNAVAILABLE: ${reason}`);
    this.name = 'CosProviderUnavailableError';
  }
}

interface CosContext {
  cos: COS;
  bucket: string;
  region: string;
  settings: StorageSettingsResolved;
}

@Injectable()
export class CosStorageProvider implements StorageProvider {
  private readonly logger = new Logger(CosStorageProvider.name);

  constructor(private readonly settings: StorageSettingsService) {}

  async putObject(input: PutObjectInput): Promise<StoredObject> {
    const ctx = await this.requireCosContext();
    const Body = await bufferize(input.body);
    const result = await ctx.cos.putObject({
      Bucket: ctx.bucket,
      Region: ctx.region,
      Key: input.key,
      Body,
      ContentType: input.contentType,
      // metadata 暂不映射(沿 Q-89-3);保留入参以匹配 PutObjectInput 接口
    });
    return {
      key: input.key,
      size: Body.length,
      contentType: input.contentType,
      etag: stripQuotes(result.ETag),
    };
  }

  // COS / S3 协议对不存在 key 也返 204(沿 Q-89-6);不显式 catch 404
  async deleteObject(key: string): Promise<void> {
    const ctx = await this.requireCosContext();
    await ctx.cos.deleteObject({
      Bucket: ctx.bucket,
      Region: ctx.region,
      Key: key,
    });
  }

  // PUT signed URL(沿 F2 + Q5c v1.0 锁 method 'PUT')
  // getObjectUrl 同步路径:Sign=true + 不依赖 GetAuthorization 异步选项 → 直接返 URL
  generateUploadUrl(input: GenerateUploadUrlInput): Promise<UploadUrlResult> {
    return this.requireCosContext().then((ctx) => {
      const url = ctx.cos.getObjectUrl({
        Bucket: ctx.bucket,
        Region: ctx.region,
        Key: input.key,
        Method: 'PUT',
        Sign: true,
        Expires: input.expiresIn,
      });
      // Q5b:headers 必填可空;COS PUT 签名约定客户端必须带 Content-Type 与签名一致
      return {
        url,
        method: 'PUT' as const,
        headers: { 'Content-Type': input.contentType },
        expiresAt: new Date(Date.now() + input.expiresIn * 1000),
      };
    });
  }

  // GET signed URL(沿 §6.4.1)
  // contentDisposition 通过 response-content-disposition query 参数附加(COS / S3 标准)
  generateDownloadUrl(input: GenerateDownloadUrlInput): Promise<DownloadUrlResult> {
    return this.requireCosContext().then((ctx) => {
      const baseUrl = ctx.cos.getObjectUrl({
        Bucket: ctx.bucket,
        Region: ctx.region,
        Key: input.key,
        Method: 'GET',
        Sign: true,
        Expires: input.expiresIn,
      });
      const url = input.contentDisposition
        ? appendQuery(baseUrl, 'response-content-disposition', input.contentDisposition)
        : baseUrl;
      return {
        url,
        expiresAt: new Date(Date.now() + input.expiresIn * 1000),
      };
    });
  }

  async headObject(key: string): Promise<HeadObjectResult> {
    const ctx = await this.requireCosContext();
    try {
      const result = await ctx.cos.headObject({
        Bucket: ctx.bucket,
        Region: ctx.region,
        Key: key,
      });
      // SDK 返 statusCode + headers + ETag;字段来源(沿 Q-89-7)
      const headers = (result.headers ?? {}) as Record<string, string | undefined>;
      const contentLength = headers['content-length'];
      const contentType = headers['content-type'];
      const lastModified = headers['last-modified'];
      return {
        exists: true,
        size: contentLength ? parseInt(contentLength, 10) : undefined,
        etag: stripQuotes(result.ETag),
        contentType,
        lastModified: lastModified ? new Date(lastModified) : undefined,
      };
    } catch (err) {
      if (isNotFoundError(err)) return { exists: false };
      throw err;
    }
  }

  async readObjectPrefix(key: string, maxBytes: number): Promise<Buffer> {
    const ctx = await this.requireCosContext();
    const result = await ctx.cos.getObject({
      Bucket: ctx.bucket,
      Region: ctx.region,
      Key: key,
      Range: `bytes=0-${maxBytes - 1}`,
    });
    return Buffer.isBuffer(result.Body)
      ? result.Body
      : Buffer.from(result.Body as unknown as Uint8Array);
  }

  // 解析 settings + 构造 COS 实例 + 4 档守护
  // 每次方法调用都查 settings;StorageSettingsService 内部 60s 缓存(沿 PR #87)
  private async requireCosContext(): Promise<CosContext> {
    const settings = await this.settings.getActiveSettings();
    if (!settings) {
      throw new CosProviderUnavailableError('storage_settings 未配置');
    }
    if (settings.providerType !== 'COS') {
      throw new CosProviderUnavailableError(`providerType=${settings.providerType} 不是 COS`);
    }
    if (settings.credentialStatus !== CredentialStatus.CONFIGURED || !settings.credentials) {
      throw new CosProviderUnavailableError(`credentialStatus=${settings.credentialStatus}`);
    }
    if (!settings.bucket || !settings.region) {
      throw new CosProviderUnavailableError('storage_settings.bucket / region 未配置');
    }
    const cos = new COS({
      SecretId: settings.credentials.secretId,
      SecretKey: settings.credentials.secretKey,
      Timeout: COS_REQUEST_TIMEOUT_MS,
    });
    return {
      cos,
      bucket: settings.bucket,
      region: settings.region,
      settings,
    };
  }
}

// 沿 PR #88 LocalProvider 同款 bufferize
async function bufferize(body: StorageBody): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    } else if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk, 'utf8'));
    } else {
      chunks.push(Buffer.from(chunk as unknown as Uint8Array));
    }
  }
  return Buffer.concat(chunks);
}

// COS 返 ETag 含双引号(沿 S3 兼容协议);去引号符合字段约定
function stripQuotes(etag: string | undefined): string | undefined {
  return etag?.replace(/^"|"$/g, '');
}

// 沿 §6.4.6 CORS 不允许 response-content-disposition header;走 query 参数
function appendQuery(url: string, key: string, value: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

// SDK 错误形态多变:statusCode=404 或 code='NoSuchKey'
function isNotFoundError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const e = err as { statusCode?: number; code?: string };
    return e.statusCode === 404 || e.code === 'NoSuchKey';
  }
  return false;
}
