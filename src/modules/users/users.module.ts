import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { AppCapabilityService } from './app-capability.service';
import { AppIdentityResolver } from './app-identity.resolver';
import { AppProfileService } from './app-profile.service';
import { AppMeController } from './controllers/app-me.controller';
import { UsersMeLegacyController } from './controllers/users-me-legacy.controller';
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
// P1-C step 1(2026-05-21):新增 UsersMeLegacyController(`/api/users/me*` 3 个 Root Legacy
// mobile-like 端点)。endpoint path / DTO / service / Guard / RBAC / throttler / Swagger
// Tag 全部 zero drift(沿 docs/api-surface-policy.md §5 项 1 + §7 P1-C step 1 + §8 P1
// 禁止事项)。
//
// **controllers 数组顺序硬约束**:`UsersMeLegacyController` 必须**先于** `UsersController`
// 注册。两者共用 `@Controller('users')` 前缀;`UsersController` 含 `@Get(':id')` /
// `@Patch(':id')` 等通配方法,NestJS / Express 按注册顺序匹配路由,若 UsersController
// 在前,`/users/me` 会被匹配为 `findOne({ id: 'me' })`,`me` 因 IdParamDto 长度 8-64
// 校验失败 → 400 BAD_REQUEST。沿"物理拆分零行为变更"原则,通过注册顺序保 `/users/me`
// 命中字面段 `me`。AppMeController 走独立 `app/v1/me` 前缀,顺序不影响。
@Module({
  imports: [DatabaseModule, AuditLogsModule, PermissionsModule],
  controllers: [UsersMeLegacyController, UsersController, AppMeController],
  providers: [UsersService, AppIdentityResolver, AppCapabilityService, AppProfileService],
  exports: [AppIdentityResolver],
})
export class UsersModule {}
