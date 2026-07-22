import { Injectable, Logger } from '@nestjs/common';

import { CosStorageProvider } from './providers/cos.provider';
import { LocalStorageProvider } from './providers/local.provider';
import { StorageSettingsService } from './storage-settings.service';
import {
  StoragePinnedLocatorError,
  StorageProviderUnavailableError,
  type PinnedStorageProvider,
  type StoragePinnedOperationOptions,
  type StorageProvider,
} from './storage.interface';
import type {
  DownloadUrlResult,
  GenerateDownloadUrlInput,
  GenerateUploadUrlInput,
  HeadObjectResult,
  PutObjectInput,
  StorageObjectReadProgress,
  StoredObject,
  StorageObjectLocator,
  StorageObjectSha256Result,
  UploadUrlResult,
} from './storage.types';

// V2.x C-7.5 Provider 选型实施 PR #8:StorageProviderRouter(沿 Q-89-1 拍板 A 动态路由)
//
// 范围:
// - 每次方法调用 live-read 一次 settings，并把同一 snapshot 绑定到本次 provider Effect
// - settings null → fallback Local(dev/test 默认)，production fail-closed
// - providerType=LOCAL → LocalStorageProvider
// - providerType=COS → CosStorageProvider
// - 未知 providerType → dev/test fallback Local + WARN；production fail-closed
//
// 不同于启动时 useFactory 静态绑定的优势:
// - 运维提交 storage_settings 后，任一实例的下一次 resolve 即时切换
// - 不需要重启服务
//
// 边界:
// - module/DI:StorageModule providers 数组装载；各 Nest 实例独立持有 provider 对象，
//   settings 当前事实由 PostgreSQL live-read 在实例间收敛
// - STORAGE_PROVIDER DI token = useExisting StorageProviderRouter(沿 PR #88 范式)

@Injectable()
export class StorageProviderRouter implements PinnedStorageProvider {
  private readonly logger = new Logger(StorageProviderRouter.name);

  constructor(
    private readonly settings: StorageSettingsService,
    private readonly local: LocalStorageProvider,
    private readonly cos: CosStorageProvider,
  ) {}

  private async resolve(): Promise<StorageProvider> {
    const r = await this.settings.getActiveSettings();
    if (!r) {
      if (this.settings.isProductionEnvironment()) {
        throw new StorageProviderUnavailableError('production storage_settings missing');
      }
      return this.local;
    }
    if (!r.enabled) {
      throw new StorageProviderUnavailableError('storage_settings.enabled=false');
    }
    if (r.providerType === 'COS') return this.cos.prepare(r);
    if (r.providerType === 'LOCAL') {
      if (this.settings.isProductionEnvironment()) {
        throw new StorageProviderUnavailableError('production providerType=LOCAL');
      }
      return this.local;
    }
    // 防御:enum 未来扩展(如 'OSS' / 'R2');沿 v1.1+ 升级路径,fallback Local
    if (this.settings.isProductionEnvironment()) {
      throw new StorageProviderUnavailableError(
        `production unknown providerType=${String(r.providerType)}`,
      );
    }
    this.logger.warn(
      `Unknown providerType=${String(r.providerType)};fallback to LocalStorageProvider`,
    );
    return this.local;
  }

  async getCurrentLocator(): Promise<StorageObjectLocator> {
    const settings = await this.settings.getActiveSettings();
    if (!settings) {
      if (this.settings.isProductionEnvironment()) {
        throw new StoragePinnedLocatorError('production storage_settings missing');
      }
      return this.local.getPinnedLocator();
    }
    if (!settings.enabled) {
      throw new StoragePinnedLocatorError('storage_settings.enabled=false');
    }
    if (settings.providerType === 'LOCAL') {
      if (this.settings.isProductionEnvironment()) {
        throw new StoragePinnedLocatorError('production providerType=LOCAL');
      }
      return this.local.getPinnedLocator();
    }
    if (settings.providerType === 'COS') {
      if (!settings.bucket || !settings.region) {
        throw new StoragePinnedLocatorError('COS bucket/region 未配置');
      }
      return {
        providerType: 'COS',
        bucket: settings.bucket,
        region: settings.region,
        localNamespace: null,
      };
    }
    throw new StoragePinnedLocatorError(`未知 providerType=${String(settings.providerType)}`);
  }

  private async assertPinnedEffectEnabled(options?: StoragePinnedOperationOptions): Promise<void> {
    if (options?.maintenance === true) return;
    const settings = await this.settings.getActiveSettings();
    if (!settings) {
      if (this.settings.isProductionEnvironment()) {
        throw new StorageProviderUnavailableError('production storage_settings missing');
      }
      return;
    }
    if (this.settings.isProductionEnvironment() && settings.providerType !== 'COS') {
      throw new StorageProviderUnavailableError(
        `production invalid providerType=${String(settings.providerType)}`,
      );
    }
    if (!settings.enabled) {
      throw new StorageProviderUnavailableError('storage_settings.enabled=false');
    }
  }

  async putObjectAt(
    locator: StorageObjectLocator,
    input: PutObjectInput,
    options?: StoragePinnedOperationOptions,
  ): Promise<StoredObject> {
    await this.assertPinnedEffectEnabled(options);
    return locator.providerType === 'COS'
      ? this.cos.putObjectAt(locator, input)
      : this.local.putObjectAt(locator, input);
  }

  async deleteObjectAt(
    locator: StorageObjectLocator,
    key: string,
    options?: StoragePinnedOperationOptions,
  ): Promise<void> {
    await this.assertPinnedEffectEnabled(options);
    return locator.providerType === 'COS'
      ? this.cos.deleteObjectAt(locator, key)
      : this.local.deleteObjectAt(locator, key);
  }

  generateUploadUrlAt(
    locator: StorageObjectLocator,
    input: GenerateUploadUrlInput,
    options?: StoragePinnedOperationOptions,
  ): Promise<UploadUrlResult> {
    return this.assertPinnedEffectEnabled(options).then(() =>
      locator.providerType === 'COS'
        ? this.cos.generateUploadUrlAt(locator, input)
        : this.local.generateUploadUrlAt(locator, input),
    );
  }

  generateDownloadUrlAt(
    locator: StorageObjectLocator,
    input: GenerateDownloadUrlInput,
    options?: StoragePinnedOperationOptions,
  ): Promise<DownloadUrlResult> {
    return this.assertPinnedEffectEnabled(options).then(() =>
      locator.providerType === 'COS'
        ? this.cos.generateDownloadUrlAt(locator, input)
        : this.local.generateDownloadUrlAt(locator, input),
    );
  }

  headObjectAt(
    locator: StorageObjectLocator,
    key: string,
    options?: StoragePinnedOperationOptions,
  ): Promise<HeadObjectResult> {
    return this.assertPinnedEffectEnabled(options).then(() =>
      locator.providerType === 'COS'
        ? this.cos.headObjectAt(locator, key)
        : this.local.headObjectAt(locator, key),
    );
  }

  readObjectPrefixAt(
    locator: StorageObjectLocator,
    key: string,
    maxBytes: number,
    options?: StoragePinnedOperationOptions,
  ): Promise<Buffer> {
    return this.assertPinnedEffectEnabled(options).then(() =>
      locator.providerType === 'COS'
        ? this.cos.readObjectPrefixAt(locator, key, maxBytes)
        : this.local.readObjectPrefixAt(locator, key, maxBytes),
    );
  }

  hashObjectSha256At(
    locator: StorageObjectLocator,
    key: string,
    onProgress?: StorageObjectReadProgress,
    options?: StoragePinnedOperationOptions,
  ): Promise<StorageObjectSha256Result> {
    return this.assertPinnedEffectEnabled(options).then(() =>
      locator.providerType === 'COS'
        ? this.cos.hashObjectSha256At(locator, key, onProgress)
        : this.local.hashObjectSha256At(locator, key, onProgress),
    );
  }

  async putObject(input: PutObjectInput): Promise<StoredObject> {
    return (await this.resolve()).putObject(input);
  }

  async deleteObject(key: string): Promise<void> {
    return (await this.resolve()).deleteObject(key);
  }

  async generateUploadUrl(input: GenerateUploadUrlInput): Promise<UploadUrlResult> {
    return (await this.resolve()).generateUploadUrl(input);
  }

  async generateDownloadUrl(input: GenerateDownloadUrlInput): Promise<DownloadUrlResult> {
    return (await this.resolve()).generateDownloadUrl(input);
  }

  async headObject(key: string): Promise<HeadObjectResult> {
    return (await this.resolve()).headObject(key);
  }

  async readObjectPrefix(key: string, maxBytes: number): Promise<Buffer> {
    return (await this.resolve()).readObjectPrefix(key, maxBytes);
  }
}
