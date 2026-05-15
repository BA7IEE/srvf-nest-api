import { Injectable, Logger } from '@nestjs/common';

import { CosStorageProvider } from './providers/cos.provider';
import { LocalStorageProvider } from './providers/local.provider';
import { StorageSettingsService } from './storage-settings.service';
import type { StorageProvider } from './storage.interface';
import type {
  DownloadUrlResult,
  GenerateDownloadUrlInput,
  GenerateUploadUrlInput,
  HeadObjectResult,
  PutObjectInput,
  StoredObject,
  UploadUrlResult,
} from './storage.types';

// V2.x C-7.5 Provider 选型实施 PR #8:StorageProviderRouter(沿 Q-89-1 拍板 A 动态路由)
//
// 范围:
// - 每次方法调用 resolve provider;依赖 StorageSettingsService 60s 缓存削减 DB 压力
// - settings null → fallback Local(dev/test 默认)
// - providerType=LOCAL → LocalStorageProvider
// - providerType=COS → CosStorageProvider
// - 未知 providerType → fallback Local + WARN(防御;沿 enum 未来扩展不破)
//
// 不同于启动时 useFactory 静态绑定的优势:
// - 运维改 storage_settings.providerType → 60s 内 / invalidate 后 / 即时切换(沿 PR #87 cache TTL)
// - 不需要重启服务
//
// 边界:
// - 单实例;StorageModule providers 数组装载
// - STORAGE_PROVIDER DI token = useExisting StorageProviderRouter(沿 PR #88 范式)

@Injectable()
export class StorageProviderRouter implements StorageProvider {
  private readonly logger = new Logger(StorageProviderRouter.name);

  constructor(
    private readonly settings: StorageSettingsService,
    private readonly local: LocalStorageProvider,
    private readonly cos: CosStorageProvider,
  ) {}

  private async resolve(): Promise<StorageProvider> {
    const r = await this.settings.getActiveSettings();
    if (!r) return this.local;
    if (r.providerType === 'COS') return this.cos;
    if (r.providerType === 'LOCAL') return this.local;
    // 防御:enum 未来扩展(如 'OSS' / 'R2');沿 v1.1+ 升级路径,fallback Local
    this.logger.warn(
      `Unknown providerType=${String(r.providerType)};fallback to LocalStorageProvider`,
    );
    return this.local;
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
}
