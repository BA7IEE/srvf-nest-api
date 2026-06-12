import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { DevStubWechatProvider } from './providers/dev-stub.provider';
import { WechatMiniRealProvider } from './providers/wechat.provider';
import { WechatCryptoService } from './wechat-crypto.service';
import { WechatService } from './wechat.service';
import { WechatSettingsController } from './wechat-settings.controller';
import { WechatSettingsService } from './wechat-settings.service';

// 微信小程序登录 T2(2026-06-12):微信通道层模块(冻结评审稿
// docs/archive/reviews/wechat-mini-login-review.md §5 文件计划;镜像 sms.module 范式)
//
// T2 范围:settings 三端点 + 双 Provider + code2session 编排 + 凭证加密。
// T3 将消费 exports:auth 模块 login-wechat.service(登录 / 绑定)与
// users 模块(me/wechat 换绑 / admin 清除)调 WechatService.code2session;
// 本模块对 User 无感知(镜像 sms E-30 边界:openid 占用 / 绑定落库 / audit 归调用方模块)。
//
// AGENTS §2 例外:providers/ 子目录经 2026-06-12 goal 拍板解锁(评审稿 §5,
// 仅限本模块本子目录;镜像 modules/sms/providers/ / modules/storage/providers/ 形态,第三例)。
@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [WechatSettingsController],
  providers: [
    WechatSettingsService,
    WechatCryptoService,
    WechatService,
    DevStubWechatProvider,
    WechatMiniRealProvider,
  ],
  exports: [WechatService, WechatSettingsService],
})
export class WechatModule {}
