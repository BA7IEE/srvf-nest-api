import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { PermissionsModule } from '../permissions/permissions.module';
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
// PR #11 范围(已合;沿评审 §6.5 / §6.6 + Q-11 拍板):
// - 新增 StorageSettingsController(GET / PATCH / POST reset-credentials)
// - StorageSettingsService 新增 getForAdmin / updateSettings / resetCredentials
//
// P0-F PR-2B 范围(2026-05-18;沿评审稿 §4.3 + 用户拍板 D1=A / D2=A):
// - imports PermissionsModule 供 StorageSettingsService 注入 RbacService(沿 PR-2A 范本)
// - 入口 @Roles 移除;Service 内 rbac.can();失败抛 RBAC_FORBIDDEN(30100)
// - 映射 seed 新增 3 条 storage-setting.* 权限点
// - D2=A:`storage-setting.reset.credentials` 不绑 ops-admin(仅 SUPER_ADMIN 短路通过)
@Module({
  imports: [DatabaseModule, PermissionsModule],
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
