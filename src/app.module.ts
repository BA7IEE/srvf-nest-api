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
import { StorageModule } from './modules/storage/storage.module';
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
import { ScheduleModule } from '@nestjs/schedule';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { SmsModule } from './modules/sms/sms.module';
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
    //   (沿 D6 v1.1;path /api/system/v1/contribution-rules;230xx 段位;
    //    attendance 预填仍由 AttendancesService.applyContributionRulePrefill 完成,本模块不动 attendance)
    ContributionRulesModule,
    // V2 第一阶段批次 6:audit_logs 基础设施
    //   (D6 v1.1 §4 / §5 / §6;path /api/system/v1/audit-logs;140xx + 141xx 段位)。
    //   schema + module + AuditLogsService.log + 2 个查询接口;
    //   emergency-contacts / certificates 写操作已迁移至 AuditLogsService。
    AuditLogsModule,
    // V2.x C-6 RBAC:permissions / RbacRole / RolePermission / UserRole / RbacService 全套 CRUD
    //   (沿 D7 v1.1 §4.2 / §5.1;path /api/system/v1/permissions、/roles 等;300xx 段位)。
    //   判权双轨:入口 Guard @Roles + Service 层 rbac.can()。
    //   P0-F(v0.15.0)后 rbac.can() 已从 attachments 扩展到管理面(rbac / config / users / audit-logs);
    //   当前接入边界以 docs/current-state.md 与 src/modules/permissions/CLAUDE.md 为准。
    PermissionsModule,
    // V2.x C-7 attachments:attachment-configs 三子模块 CRUD
    //   (D7 v1.0 §4.2 / §16 Q1-Q7;path /api/system/v1/attachment-{type,mime,size-limit}-configs;130xx 段位)。
    //   AttachmentTypeConfig / Mime / Size 三子表 CRUD 全部实装。
    //   沿 F4 v1.0:入口 @Roles(SUPER_ADMIN, ADMIN),不接 RBAC 业务判权。
    AttachmentConfigsModule,
    // V2.x C-7 attachments 主模块
    //   (D7-attachments v1.0 §5.1 / §6;path /api/admin/v1/attachments;7 端点;
    //    130xx 业务段实装 13001 / 13010-13013 / 13015;复用 30100 RBAC_FORBIDDEN)。
    //   首次业务模块接入 rbac.can();入口仅 JwtAuthGuard(F3 v1.0;不加 @Roles)。
    //   audit_logs 已集成;Provider 文件层经 StorageModule 接通。
    AttachmentsModule,
    // V2.x C-7.5 Provider:storage_settings 读取层 + 加密 helper + Provider 实装
    //   (沿 §6.5.5 + §6.6.1;Q5 / Q20-Q25)。
    //   导出 StorageSettingsService(60s 缓存)+ StorageCryptoService(AES-256-GCM);
    //   LocalProvider / CosProvider 已实装;storage-settings 后台 CRUD 已落地。
    StorageModule,
    // SMS 基础设施 T2(2026-06-10):通道层(settings 三端点 + send-logs + 双 Provider + 动态路由)
    //   (冻结评审稿 docs/archive/reviews/sms-verification-infra-review.md;path /api/system/v1/sms-*;
    //    R 模式判权;凭证 AES-256-GCM;T3 追加 SmsCodeService 与绑定端点,240xx 段位届时实装)。
    SmsModule,
    // B 队列 F5-T2(2026-06-11):@nestjs/schedule 全局装配——no-cron 铁律升级路径正式触发
    //   (冻结评审稿 docs/archive/reviews/queue-b-otp-birthday-infra-review.md 拍板④/R-5;
    //    解锁范围仅 notifications 生日批一个 @Cron;新增任何定时任务 = 新 D 档评审;
    //    数据清理不解锁,沿 docs/ops/sms-data-retention-sop.md 手动 SOP)。
    ScheduleModule.forRoot(),
    // 生日祝福 job(G-7 首个落地点;零端点/零权限码;单实例部署前提,多实例需先加锁)
    NotificationsModule,
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
