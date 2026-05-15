import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { StorageCryptoService } from './storage-crypto.service';
import { StorageSettingsService } from './storage-settings.service';

// V2.x C-7.5 Provider 选型实施 PR #6:storage 配置读取层 module(沿 §6.5.5)
//
// 本 PR 范围(沿 Q-87-2 拍板 A):
// - 导出 StorageSettingsService(读取层 + 60s 缓存)
// - 导出 StorageCryptoService(AES-256-GCM 加密 helper)
//
// **本 PR 不做**(沿立项记录 §五.2 + Q-87-2):
// - 不注册 STORAGE_PROVIDER DI token(留 PR #7-8)
// - 不导出任何 StorageProvider 实现(LocalProvider / COS Provider 留 PR #7-8)
// - 不引入 cos-nodejs-sdk-v5(留 PR #8)
// - 不挂 Controller / 不开 API 端点(留 PR #11 后台 CRUD)
@Module({
  imports: [DatabaseModule],
  providers: [StorageSettingsService, StorageCryptoService],
  exports: [StorageSettingsService, StorageCryptoService],
})
export class StorageModule {}
