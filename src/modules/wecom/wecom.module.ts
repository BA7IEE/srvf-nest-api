import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { DevStubWecomProvider } from './providers/dev-stub-wecom.provider';
import { WecomRealProvider } from './providers/wecom.provider';
import { WecomCryptoService } from './wecom-crypto.service';
import { WecomService } from './wecom.service';
import { WecomSettingsController } from './wecom-settings.controller';
import { WecomSettingsService } from './wecom-settings.service';

// 企业微信接入 T2(2026-08-01):企业微信通道层模块(冻结稿 §4.1 文件计划)
//
// T2 范围:settings 四端点 + 双 Provider + 连接诊断 + 凭证加密。
// T3 将消费 exports:auth 模块 login-wecom.service(登录 / 首次绑定)与
// users 模块(me/wecom 换绑 / admin 清除)调 WecomService;
// **本模块对 User、Member 和业务权限无感知**(冻结稿 §4.2 依赖方向:
// wecom ✕ users / wecom ✕ members / wecom ✕ activities)——
// 身份占用、绑定、refresh 撤销与 Audit 归 auth/users;受众资格归 notifications。
//
// AGENTS §1 / naming-dto-validation.md §2 例外:providers/ 子目录沿
// modules/sms/providers/ · modules/storage/providers/ · modules/wechat/providers/ 形态(第四例)。
@Module({
  imports: [DatabaseModule, AuditLogsModule, PermissionsModule],
  controllers: [WecomSettingsController],
  providers: [
    WecomSettingsService,
    WecomCryptoService,
    WecomService,
    DevStubWecomProvider,
    WecomRealProvider,
  ],
  exports: [WecomService, WecomSettingsService],
})
export class WecomModule {}
