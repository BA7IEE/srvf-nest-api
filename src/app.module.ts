import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, type ThrottlerModuleOptions } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import type { Params } from 'nestjs-pino';
import { buildLoggerModuleParams } from './bootstrap/logger-options';
import { buildThrottlerOptions } from './bootstrap/throttle-options';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { ThrottlerBizGuard } from './common/guards/throttler-biz.guard';
import { StorageModule } from './common/storage/storage.module';
import appConfig from './config/app.config';
import type { AppConfig } from './config/app.config';
import databaseConfig from './config/database.config';
import jwtConfig from './config/jwt.config';
import { DatabaseModule } from './database/database.module';
import { ActivitiesModule } from './modules/activities/activities.module';
import { ActivityRegistrationsModule } from './modules/activity-registrations/activity-registrations.module';
import { AttendancesModule } from './modules/attendances/attendances.module';
import { AuditLogsModule } from './modules/audit-logs/audit-logs.module';
import { AuthModule } from './modules/auth/auth.module';
import { CertificatesModule } from './modules/certificates/certificates.module';
import { ContributionRulesModule } from './modules/contribution-rules/contribution-rules.module';
import { DictionariesModule } from './modules/dictionaries/dictionaries.module';
import { EmergencyContactsModule } from './modules/emergency-contacts/emergency-contacts.module';
import { HealthModule } from './modules/health/health.module';
import { MemberDepartmentsModule } from './modules/member-departments/member-departments.module';
import { AttachmentConfigsModule } from './modules/attachment-configs/attachment-configs.module';
import { AttachmentsModule } from './modules/attachments/attachments.module';
import { MemberProfilesModule } from './modules/member-profiles/member-profiles.module';
import { MembersModule } from './modules/members/members.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { PermissionsModule } from './modules/permissions/permissions.module';
import { UsersModule } from './modules/users/users.module';

// V1.2:test/e2e/request-id.e2e-spec.ts 通过本路径白盒断言 buildHttpLogProps,
// 保留 re-export 维持兼容(实际定义在 bootstrap/request-id.ts)。
export { buildHttpLogProps } from './bootstrap/request-id';

function getAppConfigOrThrow(configService: ConfigService, ctx: string): AppConfig {
  const appCfg = configService.get<AppConfig>('app');
  if (!appCfg) {
    throw new Error(`app.config 未加载,${ctx} 无法初始化`);
  }
  return appCfg;
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, jwtConfig],
    }),
    // V1.1 §11.4:LoggerModule 全局注册,所有 HTTP 请求自动打日志。
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService): Params =>
        buildLoggerModuleParams(getAppConfigOrThrow(configService, 'LoggerModule')),
    }),
    // V1.1 §11.4 / TASKS.md 15.7:登录接口限流。详见 bootstrap/throttle-options.ts。
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService): ThrottlerModuleOptions =>
        buildThrottlerOptions(getAppConfigOrThrow(configService, 'ThrottlerModule')),
    }),
    DatabaseModule,
    HealthModule,
    AuthModule,
    UsersModule,
    DictionariesModule,
    OrganizationsModule,
    MembersModule,
    MemberDepartmentsModule,
    MemberProfilesModule,
    EmergencyContactsModule,
    CertificatesModule,
    // V2 第一阶段批次 3A(2026-05-11):activities + activity-registrations(含 CSV export)。
    // V2 第一阶段批次 3B(2026-05-11):attendances(双 model AttendanceSheet + AttendanceRecord;
    // APD review;/me/attendance-records;触发 eventPlaceholder('attendance.recorded') approved-only)。
    ActivitiesModule,
    ActivityRegistrationsModule,
    AttendancesModule,
    // V2 第一阶段批次 5-A(2026-05-12):contribution-rules CRUD
    //   (沿 D6 v1.1;path /api/v2/contribution-rules;230xx 段位;
    //    attendance 预填仍由 AttendancesService.applyContributionRulePrefill 完成,本模块不动 attendance)
    ContributionRulesModule,
    // V2 第一阶段批次 6 PR #1(2026-05-12):audit_logs 基础设施
    //   (D6 v1.1 §4 / §5 / §6;path /api/v2/audit-logs;140xx + 141xx 段位)。
    //   仅 schema + module + AuditLogsService.log + 2 个查询接口;
    //   8 处 emergency-contacts / certificates 写操作迁移留 PR #2(D-A 修订)。
    AuditLogsModule,
    // V2.x C-6 RBAC 实施 PR #2(2026-05-14):permissions CRUD
    //   (沿 D7 v1.1 §4.2 / §5.1 端点 1-4;path /api/v2/permissions;300xx 段位)。
    //   仅 Permission CRUD;Role / RolePermission / UserRole / RbacService / 判权
    //   接入由后续 PR #3-#6 完成。沿 D12 永不切换 + F9:本 PR 沿用 @Roles(Role.SUPER_ADMIN, Role.ADMIN)
    //   入口 Guard,**不接 RBAC 判权**;v1 14 + V2 79 接口 zero drift。
    PermissionsModule,
    // V2.x C-7 attachments 实施 PR #3(2026-05-15):attachment-configs CRUD
    //   (D7 v1.0 §4.2 / §16 Q1-Q7;path /api/v2/attachment-type-configs;130xx 段位实装 13020 / 13021 / 13023)。
    //   仅 AttachmentTypeConfig CRUD(6 端点);Mime / Size 子表 CRUD 留 PR #4 / #5;
    //   attachments 主模块 / Provider / audit / rbac.can() 接入留更后续 PR。
    //   沿 F4 v1.0:入口 @Roles(SUPER_ADMIN, ADMIN),不接 RBAC 业务判权。
    AttachmentConfigsModule,
    // V2.x C-7 attachments 实施 PR #6b(2026-05-15):attachments 主模块
    //   (D7-attachments v1.0 §5.1 / §6;path /api/v2/attachments;7 端点;
    //    130xx 业务段实装 13001 / 13010-13013 / 13015;复用 30100 RBAC_FORBIDDEN)。
    //   首次业务模块接入 rbac.can();入口仅 JwtAuthGuard(F3 v1.0;不加 @Roles)。
    //   audit_logs 接入留 PR #6c;Provider 文件层接入留 Q15 评审。
    AttachmentsModule,
    // V2.x C-7.5 Provider 选型实施 PR #6(2026-05-16):storage_settings 读取层 + 加密 helper
    //   (沿 §6.5.5 + §6.6.1;Q5 / Q20-Q25;**不**注册 STORAGE_PROVIDER DI token)。
    //   导出 StorageSettingsService(60s 缓存)+ StorageCryptoService(AES-256-GCM)。
    //   LocalProvider / COS Provider 实装留 PR #7-8;后台 CRUD 留 PR #11。
    StorageModule,
  ],
  providers: [
    // 全局 Guard 顺序(NestJS 按 providers 数组顺序执行):
    //   ThrottlerBizGuard 先挡爆破(IP 维度,粗粒度),避免攻击流量打到 JWT 解析。
    //   JwtAuthGuard 验登录(@Public 跳过)。
    //   RolesGuard 验角色(详见 ARCHITECTURE.md §7.6)。
    { provide: APP_GUARD, useClass: ThrottlerBizGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
