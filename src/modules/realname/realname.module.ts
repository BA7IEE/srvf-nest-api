import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { DevStubRealnameProvider } from './providers/dev-stub.provider';
import { TencentRealnameProvider } from './providers/tencent-realname.provider';
import { RealnameCryptoService } from './realname-crypto.service';
import { RealnameVerificationService } from './realname.service';
import { RealnameSettingsController } from './realname-settings.controller';
import { RealnameSettingsService } from './realname-settings.service';

// 招新一期 · 实名核验通道 T2(2026-06-18):实名核验通道层模块(冻结评审稿
// docs/archive/reviews/recruitment-phase1-review.md §5 文件计划;镜像 wechat.module / sms.module 范式)
//
// T2 范围:settings 三端点 + 双 Provider + verify 编排 + 凭证两段加密 + 27030/27031 域错误映射。
// T3 将消费 exports:recruitment 报名 service 调 RealnameVerificationService.verify
// (本模块对 recruitment 无感知,镜像 wechat/sms 边界:报名记账 / 状态机 / audit 归调用方模块)。
//
// AGENTS §2 例外:providers/ 子目录沿 sms/wechat 既有解锁(评审稿 E-R-21,
// 仅限本模块本子目录;第三/四例之后第五例,不构成默认范式)。
@Module({
  imports: [DatabaseModule, PermissionsModule, AttachmentsModule],
  controllers: [RealnameSettingsController],
  providers: [
    RealnameSettingsService,
    RealnameCryptoService,
    RealnameVerificationService,
    DevStubRealnameProvider,
    TencentRealnameProvider,
  ],
  exports: [RealnameVerificationService, RealnameSettingsService],
})
export class RealnameModule {}
