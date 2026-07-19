import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import appConfig from '../../../config/app.config';
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

// V2.x C-7.5 Provider 选型实施 PR #7:LocalStorageProvider(沿 F2 + Q5 + §4 模式 D)
//
// 范围(PR #7):
// - 原始实现 StorageProvider 5 方法(putObject / deleteObject / generateUploadUrl /
//   generateDownloadUrl / headObject);v0.44.0 finding #23 追加固定前缀 readObjectPrefix
// - 写入本地 fs;根目录由 STORAGE_LOCAL_ROOT env 配置(沿 Q-88-1)
// - generateUploadUrl 返 stub URL(沿 Q-88-4;dev/test 主路径走模式 D POST attachments)
// - generateDownloadUrl 返相对 URL(沿 Q-88-5 + 评审 §4 line 207)
//
// **本 PR 不做**:
// - 不接通 attachments.service(留 PR #9 wire `accessUrl` + delete)
// - 不实装本地 PUT / GET endpoint(stub URL 不会被实际命中)
// - 不实装 static middleware serve `/uploads/<key>`(留 PR #9 评估)
// - 不引入 COS Provider(留 PR #8)
//
// 安全性:`resolveKey` 防御 `../` 逃逸 root(沿 Q-88-6;纵深防御)

@Injectable()
export class LocalStorageProvider implements StorageProvider {
  private readonly logger = new Logger(LocalStorageProvider.name);
  private readonly root: string;

  constructor(@Inject(appConfig.KEY) cfg: ConfigType<typeof appConfig>) {
    this.root = path.resolve(cfg.storage.localRoot);
  }

  getPinnedLocator(): StorageObjectLocator {
    return {
      providerType: 'LOCAL',
      bucket: null,
      region: null,
      localNamespace: this.root,
    };
  }

  putObjectAt(locator: StorageObjectLocator, input: PutObjectInput): Promise<StoredObject> {
    return this.putObjectInternal(input, this.pinnedRoot(locator));
  }

  deleteObjectAt(locator: StorageObjectLocator, key: string): Promise<void> {
    return this.deleteObjectInternal(key, this.pinnedRoot(locator));
  }

  generateUploadUrlAt(
    locator: StorageObjectLocator,
    input: GenerateUploadUrlInput,
  ): Promise<UploadUrlResult> {
    this.assertSignedUrlUsesCurrentRoot(locator);
    return this.generateUploadUrl(input);
  }

  generateDownloadUrlAt(
    locator: StorageObjectLocator,
    input: GenerateDownloadUrlInput,
  ): Promise<DownloadUrlResult> {
    this.assertSignedUrlUsesCurrentRoot(locator);
    return this.generateDownloadUrl(input);
  }

  headObjectAt(locator: StorageObjectLocator, key: string): Promise<HeadObjectResult> {
    return this.headObjectInternal(key, this.pinnedRoot(locator));
  }

  readObjectPrefixAt(
    locator: StorageObjectLocator,
    key: string,
    maxBytes: number,
  ): Promise<Buffer> {
    return this.readObjectPrefixInternal(key, maxBytes, this.pinnedRoot(locator));
  }

  hashObjectSha256At(
    locator: StorageObjectLocator,
    key: string,
    onProgress?: StorageObjectReadProgress,
  ): Promise<StorageObjectSha256Result> {
    return this.hashObjectSha256Internal(key, this.pinnedRoot(locator), onProgress);
  }

  putObject(input: PutObjectInput): Promise<StoredObject> {
    return this.putObjectInternal(input, this.root);
  }

  private async putObjectInternal(input: PutObjectInput, root: string): Promise<StoredObject> {
    const filePath = this.resolveKey(input.key, root);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const body = await bufferize(input.body);
    await fs.writeFile(filePath, body);
    const etag = createHash('md5').update(body).digest('hex');
    return {
      key: input.key,
      size: body.length,
      contentType: input.contentType,
      etag,
    };
  }

  // ENOENT 视作成功(幂等;沿 COS / S3 删除契约)
  deleteObject(key: string): Promise<void> {
    return this.deleteObjectInternal(key, this.root);
  }

  private async deleteObjectInternal(key: string, root: string): Promise<void> {
    const filePath = this.resolveKey(key, root);
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.logger.warn('LocalProvider deleteObject: object already absent (idempotent)');
    }
  }

  // LocalProvider 不接 client direct PUT;返 stub URL
  // dev/test 主路径走模式 D(POST /api/admin/v1/attachments 直传 putObject);
  // 此处仅保留接口对称性 + expiresAt 计算(沿 Q5b headers 必填可空 / Q5c method PUT 默认)
  // 非 async:无 await 调用(沿 require-await lint);保持接口签名 Promise<T>
  generateUploadUrl(input: GenerateUploadUrlInput): Promise<UploadUrlResult> {
    const stubUrl = `/internal/storage/local-stub-upload/${encodeURIComponent(input.key)}`;
    return Promise.resolve({
      url: stubUrl,
      method: 'PUT' as const,
      headers: {},
      expiresAt: new Date(Date.now() + input.expiresIn * 1000),
    });
  }

  // 相对 URL `/uploads/<key>?expires=<ts>`(沿评审 §4 line 207)
  // static middleware 是否实装留 PR #9 决定;字段类型是 string 不要求绝对 URL
  // 非 async:无 await 调用(沿 require-await lint)
  generateDownloadUrl(input: GenerateDownloadUrlInput): Promise<DownloadUrlResult> {
    const expiresMs = Date.now() + input.expiresIn * 1000;
    const url = `/uploads/${encodeURIComponent(input.key)}?expires=${Math.floor(expiresMs / 1000)}`;
    return Promise.resolve({ url, expiresAt: new Date(expiresMs) });
  }

  headObject(key: string): Promise<HeadObjectResult> {
    return this.headObjectInternal(key, this.root);
  }

  private async headObjectInternal(key: string, root: string): Promise<HeadObjectResult> {
    const filePath = this.resolveKey(key, root);
    try {
      const stat = await fs.stat(filePath);
      return {
        exists: true,
        size: stat.size,
        lastModified: stat.mtime,
        // etag / contentType 未持久化;留 undefined(沿 HeadObjectResult 可选字段)
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { exists: false };
      }
      throw err;
    }
  }

  readObjectPrefix(key: string, maxBytes: number): Promise<Buffer> {
    return this.readObjectPrefixInternal(key, maxBytes, this.root);
  }

  private async readObjectPrefixInternal(
    key: string,
    maxBytes: number,
    root: string,
  ): Promise<Buffer> {
    const file = await fs.open(this.resolveKey(key, root), 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await file.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
  }

  private async hashObjectSha256Internal(
    key: string,
    root: string,
    onProgress?: StorageObjectReadProgress,
  ): Promise<StorageObjectSha256Result> {
    const file = await fs.open(this.resolveKey(key, root), 'r');
    const hash = createHash('sha256');
    let size = 0;
    try {
      const stream = file.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 });
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += bytes.length;
        hash.update(bytes);
        await onProgress?.(size);
      }
    } finally {
      await file.close();
    }
    return { size, checksum: hash.digest('hex') };
  }

  // 安全拼接 + 防 `../` 逃逸 root(沿 Q-88-6)
  private resolveKey(key: string, root: string): string {
    const full = path.resolve(root, key);
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (full !== root && !full.startsWith(rootWithSep)) {
      throw new Error(`LocalProvider key path escape: ${key}`);
    }
    return full;
  }

  private pinnedRoot(locator: StorageObjectLocator): string {
    if (
      locator.providerType !== 'LOCAL' ||
      locator.bucket !== null ||
      locator.region !== null ||
      !locator.localNamespace
    ) {
      throw new StoragePinnedLocatorError('LOCAL ledger locator 不完整');
    }
    const resolved = path.resolve(locator.localNamespace);
    if (!path.isAbsolute(locator.localNamespace) || resolved !== locator.localNamespace) {
      throw new StoragePinnedLocatorError('LOCAL namespace 必须是 canonical absolute path');
    }
    return resolved;
  }

  private assertSignedUrlUsesCurrentRoot(locator: StorageObjectLocator): void {
    const pinnedRoot = this.pinnedRoot(locator);
    if (pinnedRoot !== this.root) {
      throw new StoragePinnedLocatorError(
        'LOCAL signed URL 只能使用当前 canonical namespace；pinned namespace 已切换',
      );
    }
  }
}

// Buffer | NodeJS.ReadableStream → Buffer
async function bufferize(body: StorageBody): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    } else if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk, 'utf8'));
    } else {
      // Uint8Array / ArrayBuffer / TypedArray:Buffer.from 接受 ArrayBufferView
      chunks.push(Buffer.from(chunk as unknown as Uint8Array));
    }
  }
  return Buffer.concat(chunks);
}
