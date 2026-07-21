import { Injectable } from '@nestjs/common';
import COS from 'cos-nodejs-sdk-v5';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';

import { StorageSettingsService } from '../storage-settings.service';
import { CredentialStatus, type StorageSettingsResolved } from '../storage-settings.types';
import { StoragePinnedLocatorError, type StorageProvider } from '../storage.interface';
import type {
  DownloadUrlResult,
  GenerateDownloadUrlInput,
  GenerateUploadUrlInput,
  HeadObjectResult,
  PutObjectInput,
  StorageObjectReadProgress,
  StorageBody,
  StoredObject,
  StorageObjectLocator,
  StorageObjectSha256Result,
  UploadUrlResult,
} from '../storage.types';

// V2.x C-7.5 Provider 选型实施 PR #8:CosStorageProvider(沿 F3 + F5 + Q5 + §6.4)
//
// 范围(PR #8):
// - 原始实现 StorageProvider 5 方法,通过 cos-nodejs-sdk-v5 调腾讯云 COS;
//   v0.44.0 finding #23 追加 ranged getObject 固定前缀 readObjectPrefix
// - 既有直接方法各自 live-read 一次 settings；prepare(settings) 绑定 supplied snapshot，
//   同一 Effect 的凭证 + bucket + region 不再重读
// - 非 pinned 5 档守护:settings null / enabled=false / providerType ≠ COS /
//   credentialStatus ≠ CONFIGURED / bucket+region 缺失
// - pinned 方法按历史 locator 解析；Router 默认先检查 enabled，仅显式人工 maintenance 绕过
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
}

@Injectable()
export class CosStorageProvider implements StorageProvider {
  constructor(private readonly settings: StorageSettingsService) {}

  /** supplied settings snapshot 的同步 prepare；返回适配器不会再次读取 settings。 */
  prepare(settings: StorageSettingsResolved | null): StorageProvider {
    const ctx = this.requireCosContext(settings);
    return {
      putObject: (input) => this.putObjectWithContext(ctx, input),
      deleteObject: (key) => this.deleteObjectWithContext(ctx, key),
      generateUploadUrl: (input) => this.generateUploadUrlWithContext(ctx, input),
      generateDownloadUrl: (input) => this.generateDownloadUrlWithContext(ctx, input),
      headObject: (key) => this.headObjectWithContext(ctx, key),
      readObjectPrefix: (key, maxBytes) => this.readObjectPrefixWithContext(ctx, key, maxBytes),
    };
  }

  async putObject(input: PutObjectInput): Promise<StoredObject> {
    return (await this.resolvePrepared()).putObject(input);
  }

  async putObjectAt(locator: StorageObjectLocator, input: PutObjectInput): Promise<StoredObject> {
    return this.putObjectWithContext(await this.resolveContext(locator), input);
  }

  private async putObjectWithContext(
    ctx: CosContext,
    input: PutObjectInput,
  ): Promise<StoredObject> {
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
    return (await this.resolvePrepared()).deleteObject(key);
  }

  async deleteObjectAt(locator: StorageObjectLocator, key: string): Promise<void> {
    return this.deleteObjectWithContext(await this.resolveContext(locator), key);
  }

  private async deleteObjectWithContext(ctx: CosContext, key: string): Promise<void> {
    await ctx.cos.deleteObject({
      Bucket: ctx.bucket,
      Region: ctx.region,
      Key: key,
    });
  }

  // PUT signed URL(沿 F2 + Q5c v1.0 锁 method 'PUT')
  // getObjectUrl 同步路径:Sign=true + 不依赖 GetAuthorization 异步选项 → 直接返 URL
  async generateUploadUrl(input: GenerateUploadUrlInput): Promise<UploadUrlResult> {
    return (await this.resolvePrepared()).generateUploadUrl(input);
  }

  async generateUploadUrlAt(
    locator: StorageObjectLocator,
    input: GenerateUploadUrlInput,
  ): Promise<UploadUrlResult> {
    return this.generateUploadUrlWithContext(await this.resolveContext(locator), input);
  }

  private generateUploadUrlWithContext(
    ctx: CosContext,
    input: GenerateUploadUrlInput,
  ): Promise<UploadUrlResult> {
    const url = ctx.cos.getObjectUrl({
      Bucket: ctx.bucket,
      Region: ctx.region,
      Key: input.key,
      Method: 'PUT',
      Sign: true,
      Expires: input.expiresIn,
    });
    // Q5b:headers 必填可空;COS PUT 签名约定客户端必须带 Content-Type 与签名一致
    return Promise.resolve({
      url,
      method: 'PUT' as const,
      headers: { 'Content-Type': input.contentType },
      expiresAt: new Date(Date.now() + input.expiresIn * 1000),
    });
  }

  // GET signed URL(沿 §6.4.1)
  // contentDisposition 通过 response-content-disposition query 参数附加(COS / S3 标准)
  async generateDownloadUrl(input: GenerateDownloadUrlInput): Promise<DownloadUrlResult> {
    return (await this.resolvePrepared()).generateDownloadUrl(input);
  }

  async generateDownloadUrlAt(
    locator: StorageObjectLocator,
    input: GenerateDownloadUrlInput,
  ): Promise<DownloadUrlResult> {
    return this.generateDownloadUrlWithContext(await this.resolveContext(locator), input);
  }

  private generateDownloadUrlWithContext(
    ctx: CosContext,
    input: GenerateDownloadUrlInput,
  ): Promise<DownloadUrlResult> {
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
    return Promise.resolve({
      url,
      expiresAt: new Date(Date.now() + input.expiresIn * 1000),
    });
  }

  async headObject(key: string): Promise<HeadObjectResult> {
    return (await this.resolvePrepared()).headObject(key);
  }

  async headObjectAt(locator: StorageObjectLocator, key: string): Promise<HeadObjectResult> {
    return this.headObjectWithContext(await this.resolveContext(locator), key);
  }

  private async headObjectWithContext(ctx: CosContext, key: string): Promise<HeadObjectResult> {
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
    return (await this.resolvePrepared()).readObjectPrefix(key, maxBytes);
  }

  async readObjectPrefixAt(
    locator: StorageObjectLocator,
    key: string,
    maxBytes: number,
  ): Promise<Buffer> {
    return this.readObjectPrefixWithContext(await this.resolveContext(locator), key, maxBytes);
  }

  private async readObjectPrefixWithContext(
    ctx: CosContext,
    key: string,
    maxBytes: number,
  ): Promise<Buffer> {
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

  async hashObjectSha256At(
    locator: StorageObjectLocator,
    key: string,
    onProgress?: StorageObjectReadProgress,
  ): Promise<StorageObjectSha256Result> {
    const ctx = await this.resolveContext(locator);
    const hash = createHash('sha256');
    let size = 0;
    const output = new Writable({
      write(chunk, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += bytes.length;
        hash.update(bytes);
        if (!onProgress) {
          callback();
          return;
        }
        void onProgress(size).then(
          () => callback(),
          (error: unknown) => callback(asError(error)),
        );
      },
    });
    // Wait for both the SDK result and the digest sink. This proves every async progress/lease
    // callback completed before digest(), and observes COS's mirrored Output error path.
    const [result] = await Promise.all([
      ctx.cos.getObject({
        Bucket: ctx.bucket,
        Region: ctx.region,
        Key: key,
        Output: output,
      }),
      finished(output),
    ]);
    return { size, checksum: hash.digest('hex'), etag: stripQuotes(result.ETag) };
  }

  private async resolvePrepared(): Promise<StorageProvider> {
    return this.prepare(await this.settings.getActiveSettings());
  }

  private async resolveContext(expected: StorageObjectLocator): Promise<CosContext> {
    return this.requireCosContext(await this.settings.getActiveSettings(), expected);
  }

  // 解析 supplied snapshot + 构造 COS 实例 + 4 档守护；不读取 StorageSettingsService。
  private requireCosContext(
    settings: StorageSettingsResolved | null,
    expected?: StorageObjectLocator,
  ): CosContext {
    if (!settings) {
      throw new CosProviderUnavailableError('storage_settings 未配置');
    }
    if (!expected && !settings.enabled) {
      throw new CosProviderUnavailableError('storage_settings.enabled=false');
    }
    if (!expected && settings.providerType !== 'COS') {
      throw new CosProviderUnavailableError(`providerType=${settings.providerType} 不是 COS`);
    }
    if (expected && expected.providerType !== 'COS') {
      throw new StoragePinnedLocatorError('非 COS locator 不能路由到 CosStorageProvider');
    }
    if (settings.credentialStatus !== CredentialStatus.CONFIGURED || !settings.credentials) {
      throw new CosProviderUnavailableError(`credentialStatus=${settings.credentialStatus}`);
    }
    const bucket = expected?.bucket ?? settings.bucket;
    const region = expected?.region ?? settings.region;
    if (!bucket || !region) {
      throw new CosProviderUnavailableError('COS bucket / region 未配置');
    }
    if (expected && expected.localNamespace !== null) {
      throw new StoragePinnedLocatorError('COS locator 不允许 localNamespace');
    }
    const cos = new COS({
      SecretId: settings.credentials.secretId,
      SecretKey: settings.credentials.secretKey,
      Timeout: COS_REQUEST_TIMEOUT_MS,
    });
    return {
      cos,
      bucket,
      region,
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('storage object hash progress failed');
}
