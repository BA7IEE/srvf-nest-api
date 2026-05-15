import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { CosStorageProvider } from './providers/cos.provider';
import { LocalStorageProvider } from './providers/local.provider';
import { StorageCryptoService } from './storage-crypto.service';
import { StorageProviderRouter } from './storage-provider.router';
import { STORAGE_PROVIDER } from './storage.constants';
import { StorageSettingsService } from './storage-settings.service';

// V2.x C-7.5 Provider 选型实施 PR #6-8:storage 配置读取层 + Provider × 2 + 动态路由
// (沿 §6.5.5 + F2 + F3 + Q5 + Q-89-1)
//
// PR #6 范围(已合):导出 StorageSettingsService + StorageCryptoService
// PR #7 范围(已合):注册 LocalStorageProvider(静态绑定 STORAGE_PROVIDER)
// PR #8 范围(本 PR;沿 Q-89-1 拍板 A 动态路由):
// - 引入 cos-nodejs-sdk-v5(沿 Q-89-8)
// - 新增 CosStorageProvider(沿 F3 腾讯 COS 正式 Provider)
// - 新增 StorageProviderRouter(每次方法调用动态选 Local / COS;沿 settings 60s cache 控压力)
// - STORAGE_PROVIDER 改 useExisting StorageProviderRouter
//
// **本 PR 不做**:
// - 不接通 attachments.service(留 PR #9 wire accessUrl + delete)
// - 不挂 Controller / 不开 API 端点(留 PR #10 upload-url / confirm-upload + PR #11 后台 CRUD)
// - 不修改 attachments / RBAC / audit-logs / 其他业务模块
@Module({
  imports: [DatabaseModule],
  providers: [
    StorageSettingsService,
    StorageCryptoService,
    LocalStorageProvider,
    CosStorageProvider,
    StorageProviderRouter,
    { provide: STORAGE_PROVIDER, useExisting: StorageProviderRouter },
  ],
  exports: [StorageSettingsService, StorageCryptoService, STORAGE_PROVIDER],
})
export class StorageModule {}
