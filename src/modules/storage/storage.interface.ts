import type {
  PutObjectInput,
  StoredObject,
  GenerateUploadUrlInput,
  UploadUrlResult,
  GenerateDownloadUrlInput,
  DownloadUrlResult,
  HeadObjectResult,
  StorageObjectReadProgress,
  StorageObjectLocator,
  StorageObjectSha256Result,
} from './storage.types';

// StorageProvider 接口(C-7.5 v1.0 锁;沿 F5 / Q5 + §7.4)
// 详见 ARCHITECTURE.md §3 + §4 + 附录第 10 步 + CLAUDE.md §1
//      + docs/批次7_provider选型_API前评审.md §7.4
//      + docs/批次7_provider选型_V2x立项记录.md §二.2
//
// **本 PR(C-7.5 实施 PR #5)仅扩展接口 + 类型,不实装任何 Provider**:
// 以下能力在 C-7.5 后续 PR 落地后已可用:
// - LocalStorageProvider / CosStorageProvider(src/modules/storage/providers/)
// - StorageModule + StorageProviderRouter(src/modules/storage/storage.module.ts)
// - cos-nodejs-sdk-v5(已在 package.json 引入)
// 0 runtime impact / 0 callsite / 0 module wiring。
//
// Q5 锁定 3 子项(沿 §7.4):
// - Q5a:expiresIn = number(秒);不接受 Date / Duration 字符串
// - Q5b:UploadUrlResult.headers 必填(可空对象);LocalProvider 返 {} / COS 返 { 'Content-Type': mime, ... }
// - Q5c:UploadUrlResult.method = 'PUT' | 'POST' 联合保留;v1.0 全返 'PUT'(沿 Q19 / Q13);
//        'POST' 路径留未来 multipart upload 启用时再实施
//
// 仍不收录的方法(留 v1.1+ 评审):
// - getStream:走 signed URL 直下(沿 F2);manual reconcile 仅暴露 pinned SHA-256 摘要，
//   不把通用对象流或内容交给业务层
// - copyObject / moveObject:本批次不实装
// - getMultipartUploadId / completeMultipartUpload:Q13 锁不实施(单文件 ≤ 5GB 走 PUT signed URL)
// v0.44.0 finding #23 仅为 confirm-upload 安全校验增加固定上限前缀读取;
// 不开放通用 range / download 能力,调用方不得用它承载文件下载。
export interface StorageProvider {
  // === v1 已有(沿用)===
  putObject(input: PutObjectInput): Promise<StoredObject>;
  deleteObject(key: string): Promise<void>;

  // === C-7.5 v1.0 新增(沿 F5 / Q5 / §7.4)===
  generateUploadUrl(input: GenerateUploadUrlInput): Promise<UploadUrlResult>;
  generateDownloadUrl(input: GenerateDownloadUrlInput): Promise<DownloadUrlResult>;
  headObject(key: string): Promise<HeadObjectResult>;
  readObjectPrefix(key: string, maxBytes: number): Promise<Buffer>;
}

export class StoragePinnedLocatorError extends Error {
  constructor(reason: string) {
    super(`STORAGE_PINNED_LOCATOR_UNAVAILABLE: ${reason}`);
    this.name = 'StoragePinnedLocatorError';
  }
}

// Durable ledger 只能经 pinned locator 调 Provider；动态 settings 切换不得把旧 key
// 静默路由到当前 bucket/root。STORAGE_PROVIDER 的 production 实例(StorageProviderRouter)
// 实现本接口，测试 fake 可按需实现。
export interface PinnedStorageProvider extends StorageProvider {
  getCurrentLocator(): Promise<StorageObjectLocator>;
  putObjectAt(locator: StorageObjectLocator, input: PutObjectInput): Promise<StoredObject>;
  deleteObjectAt(locator: StorageObjectLocator, key: string): Promise<void>;
  generateUploadUrlAt(
    locator: StorageObjectLocator,
    input: GenerateUploadUrlInput,
  ): Promise<UploadUrlResult>;
  generateDownloadUrlAt(
    locator: StorageObjectLocator,
    input: GenerateDownloadUrlInput,
  ): Promise<DownloadUrlResult>;
  headObjectAt(locator: StorageObjectLocator, key: string): Promise<HeadObjectResult>;
  readObjectPrefixAt(locator: StorageObjectLocator, key: string, maxBytes: number): Promise<Buffer>;
  hashObjectSha256At(
    locator: StorageObjectLocator,
    key: string,
    onProgress?: StorageObjectReadProgress,
  ): Promise<StorageObjectSha256Result>;
}

export function isPinnedStorageProvider(value: StorageProvider): value is PinnedStorageProvider {
  const candidate = value as Partial<PinnedStorageProvider>;
  return (
    typeof candidate.getCurrentLocator === 'function' &&
    typeof candidate.putObjectAt === 'function' &&
    typeof candidate.deleteObjectAt === 'function' &&
    typeof candidate.generateUploadUrlAt === 'function' &&
    typeof candidate.generateDownloadUrlAt === 'function' &&
    typeof candidate.headObjectAt === 'function' &&
    typeof candidate.readObjectPrefixAt === 'function' &&
    typeof candidate.hashObjectSha256At === 'function'
  );
}
