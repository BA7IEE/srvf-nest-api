import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { SmsModule } from '../sms/sms.module';
import { WechatModule } from '../wechat/wechat.module';
import { AppCapabilityService } from './app-capability.service';
import { AppIdentityResolver } from './app-identity.resolver';
import { AppProfileService } from './app-profile.service';
import { AdminMeController } from './controllers/admin-me.controller';
import { AppMeController } from './controllers/app-me.controller';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

// P0-D PR-3(2026-05-17):import AuditLogsModule 注入 AuditLogsService,供
// UsersService.changeMyPassword 在事务内写 audit log(event: password.change.self)。
// 沿 emergency-contacts / certificates / activity-registrations 等模块的接入范式。
//
// P0-F PR-3B(2026-05-18):import PermissionsModule 注入 RbacService,供 UsersService
// 8 个管理方法首句 `await this.assertCanOrThrow(currentUser, '<permission.code>')`。
// 沿 PR-1 permissions / PR-2A dict / org / member-department / contribution-rule /
// PR-2B attachment-config / storage-setting 接入范式。
//
// Phase 2 P2-1(2026-05-19):新增 AppMeController(/api/app/v1/me*)+ AppIdentityResolver
// + AppCapabilityService。沿 docs/app-api-phase-2-review.md §2 / §7.1;
// 旧 UsersController + UsersService 行为**逐字不变**(沿 §3.2 不动 v1 legacy + §9.2 #9 path stability)。
//
// Phase 2 P2-2(2026-05-20):新增 AppProfileService 供 AppMeController 的 GET / PATCH
// /me/profile 使用(沿 docs/app-api-p2-2-profile-review.md §7.2)。
// AppProfileService 注入 PrismaService(派生 hasMemberProfile 单字段 select)+ UsersService
// (PATCH 复用 updateMyProfile;沿 §7.4 显式 safeDto)+ AppIdentityResolver(P2-1 复用)。
// **不**注入 MemberProfilesService(避免跨模块耦合;沿 §7.2 + 风险表 11.15)。
//
// Phase 2 P2-4a(2026-05-20):exports AppIdentityResolver 供 ActivitiesModule 注入
// (沿 docs/archive/reviews/app-api-p2-4-activities-review.md §6.1 准入复用 P2-1 范式)。
// 仅 exports resolver,**不** exports UsersService / AppCapabilityService / AppProfileService
// (避免下游模块隐式扩散对 users 内部能力的依赖)。
//
// Route B Phase 4d(2026-06-01):`UsersMeLegacyController`(`/api/users/me*`)已删除
// (app/v1/me* 对等存在;沿 docs/api-surface-migration-plan.md §6 Phase 4)。`UsersController`
// 已收为 `@Controller('admin/v1/users')`,与 `AppMeController`(`app/v1/me`)前缀独立,
// 不再有 `@Controller('users')` 前缀共享,故无注册顺序约束。
// SMS 基础设施 T3(2026-06-10):import SmsModule 注入 SmsCodeService,供 UsersService
// 的 sendMyPhoneBindCode / bindMyPhone(验码即消费)使用;评审稿 E-30 边界:sms 模块对
// User 无感知,phone 占用 / 绑定落库 / audit 全部留在本模块。单向依赖 users → sms,无环。
// 微信小程序登录 T3(2026-06-12):import WechatModule 注入 WechatService(code2session),
// 供 bindMyWechat(me/wechat 换绑)使用;同款边界:wechat 模块对 User 无感知,
// openid 占用 / 绑定落库 / audit 全部留在本模块。单向依赖 users → wechat,无环。
@Module({
  imports: [DatabaseModule, AuditLogsModule, PermissionsModule, SmsModule, WechatModule],
  // admin/v1/me 本人身份只读 bootstrap(2026-06-14):AdminMeController 物理隔离于 Admin surface
  // (单一 @ApiTags('Admin - Me'),非 Mixed),复用 UsersService.getMyAdminIdentity 薄读路径。
  controllers: [UsersController, AppMeController, AdminMeController],
  providers: [UsersService, AppIdentityResolver, AppCapabilityService, AppProfileService],
  exports: [AppIdentityResolver],
})
export class UsersModule {}
