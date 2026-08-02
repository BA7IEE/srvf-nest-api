import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { DevStubWecomProvider } from './providers/dev-stub-wecom.provider';
import { WecomRealProvider } from './providers/wecom.provider';
import { WecomAuthAttemptService } from './wecom-auth-attempt.service';
import { WecomCryptoService } from './wecom-crypto.service';
import { WecomService } from './wecom.service';
import { WecomSettingsController } from './wecom-settings.controller';
import { WecomSettingsService } from './wecom-settings.service';

// 企业微信接入 T2(2026-08-01):企业微信通道层模块(冻结稿 §4.1 文件计划)
//
// T2 范围:settings 四端点 + 双 Provider + 连接诊断 + 凭证加密。
// T3(2026-08-02)接入:auth 模块 login-wecom.service(登录 / 首次绑定)与
// users 模块 user-wecom-binding.service(me/wecom 换绑 / admin 清除)消费 exports;
// **本模块对 User、Member 和业务权限无感知**(冻结稿 §4.2 依赖方向:
// wecom ✕ users / wecom ✕ members / wecom ✕ activities)——
// 身份占用、绑定、refresh 撤销与 Audit 归 auth/users;受众资格归 notifications。
//
// ⚠️ `WecomAuthAttemptService` 是本模块**唯一**写 `wecom_auth_attempts` 的地方,
// 但它**不写** `wecom_identities` —— 后者仍归 auth/users(依赖方向不因新增 Service 而松动)。
// attempt 表存的是 OAuth 一次性凭证台账,不含任何 User 语义(subjectUserId 只是外键,
// 本模块从不据它做业务判断)。
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
    WecomAuthAttemptService,
    DevStubWecomProvider,
    WecomRealProvider,
  ],
  exports: [WecomService, WecomSettingsService, WecomAuthAttemptService],
})
export class WecomModule {}
