import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { DevStubSmsProvider } from './providers/dev-stub.provider';
import { TencentSmsProvider } from './providers/tencent-sms.provider';
import { SmsCryptoService } from './sms-crypto.service';
import { SmsProviderRouter } from './sms-provider.router';
import { SmsSendLogsController } from './sms-send-logs.controller';
import { SmsSendLogsService } from './sms-send-logs.service';
import { SmsSettingsController } from './sms-settings.controller';
import { SmsSettingsService } from './sms-settings.service';

// SMS 基础设施 T2(2026-06-10):通道层模块(冻结评审稿
// docs/archive/reviews/sms-verification-infra-review.md §5 文件计划;镜像 storage.module 范式)
//
// T2 范围:settings 三端点 + send-logs 列表 + 双 Provider + 动态路由 + 凭证加密。
// T3 追加:SmsCodeService(签发/校验/防刷)并 export 供 users 模块消费。
//
// AGENTS §2 例外:providers/ 子目录经 2026-06-10 goal 拍板解锁(评审稿 §5,
// 仅限本模块本子目录;镜像 common/storage/providers/ 形态)。
@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [SmsSettingsController, SmsSendLogsController],
  providers: [
    SmsSettingsService,
    SmsSendLogsService,
    SmsCryptoService,
    DevStubSmsProvider,
    TencentSmsProvider,
    SmsProviderRouter,
  ],
  exports: [SmsSettingsService, SmsProviderRouter],
})
export class SmsModule {}
