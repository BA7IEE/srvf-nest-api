import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { CosStorageProvider } from './providers/cos.provider';
import { LocalStorageProvider } from './providers/local.provider';
import { StorageCryptoService } from './storage-crypto.service';
import { StorageProviderRouter } from './storage-provider.router';
import { STORAGE_PROVIDER } from './storage.constants';
import { StorageSettingsController } from './storage-settings.controller';
import { StorageSettingsService } from './storage-settings.service';

// V2.x C-7.5 Provider 选型实施 PR #6-11:storage 配置读取层 + Provider × 2 + 动态路由 + admin Controller
// (沿 §6.5.5 + F2 + F3 + Q5 + Q-89-1)
//
// PR #6 范围(已合):导出 StorageSettingsService + StorageCryptoService
// PR #7 范围(已合):注册 LocalStorageProvider
// PR #8 范围(已合):新增 CosStorageProvider + StorageProviderRouter(动态路由;沿 Q-89-1)
// PR #11 范围(本 PR;沿评审 §6.5 / §6.6 + Q-11 拍板):
// - 新增 StorageSettingsController(GET / PATCH / POST reset-credentials)
// - 端点入口 @Roles(SUPER_ADMIN, ADMIN);**不**接 rbac.can();**不**新增 BizCode / AuditLogEvent
// - StorageSettingsService 新增 getForAdmin / updateSettings / resetCredentials
//
// **本 PR 不做**:
// - 不引入新依赖 / 不改 prisma / 不动 Provider 实现 / 不动 attachments
@Module({
  imports: [DatabaseModule],
  controllers: [StorageSettingsController],
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
