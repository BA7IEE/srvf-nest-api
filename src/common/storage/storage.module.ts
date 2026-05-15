import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { LocalStorageProvider } from './providers/local.provider';
import { StorageCryptoService } from './storage-crypto.service';
import { STORAGE_PROVIDER } from './storage.constants';
import { StorageSettingsService } from './storage-settings.service';

// V2.x C-7.5 Provider 选型实施 PR #6-7:storage 配置读取层 + LocalStorageProvider
// (沿 §6.5.5 + F2 + Q5)
//
// PR #6 范围(已合并):
// - 导出 StorageSettingsService(读取层 + 60s 缓存)
// - 导出 StorageCryptoService(AES-256-GCM 加密 helper)
//
// PR #7 范围(本 PR;沿 Q-88-2 / Q-88-3):
// - 注册 STORAGE_PROVIDER DI token = LocalStorageProvider(useExisting)
// - 沿 F2:dev / test 主路径;production 走 COS Provider 留 PR #8 改 useFactory 切换
//
// **本 PR 不做**(沿立项记录 §五.2 + PR #88 边界):
// - 不引入 cos-nodejs-sdk-v5(留 PR #8)
// - 不实装 COS Provider(留 PR #8)
// - 不接通 attachments.service(留 PR #9 wire accessUrl + delete)
// - 不挂 Controller / 不开 API 端点(留 PR #11 后台 CRUD)
@Module({
  imports: [DatabaseModule],
  providers: [
    StorageSettingsService,
    StorageCryptoService,
    LocalStorageProvider,
    { provide: STORAGE_PROVIDER, useExisting: LocalStorageProvider },
  ],
  exports: [StorageSettingsService, StorageCryptoService, STORAGE_PROVIDER],
})
export class StorageModule {}
