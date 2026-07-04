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
import { AnnouncementImportModule } from './modules/announcement-import/announcement-import.module';
import { AttendancesModule } from './modules/attendances/attendances.module';
import { AuditLogsModule } from './modules/audit-logs/audit-logs.module';
import { AuthModule } from './modules/auth/auth.module';
import { AuthzModule } from './modules/authz/authz.module';
import { CertificatesModule } from './modules/certificates/certificates.module';
import { ContentModule } from './modules/content/content.module';
import { ContributionRulesModule } from './modules/contribution-rules/contribution-rules.module';
import { DictionariesModule } from './modules/dictionaries/dictionaries.module';
import { EmergencyContactsModule } from './modules/emergency-contacts/emergency-contacts.module';
import { HealthModule } from './modules/health/health.module';
import { InsurancesModule } from './modules/insurances/insurances.module';
import { MemberDepartmentsModule } from './modules/member-departments/member-departments.module';
import { AttachmentConfigsModule } from './modules/attachment-configs/attachment-configs.module';
import { AttachmentsModule } from './modules/attachments/attachments.module';
import { MemberProfilesModule } from './modules/member-profiles/member-profiles.module';
import { MembersModule } from './modules/members/members.module';
import { MetaModule } from './modules/meta/meta.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { PermissionsModule } from './modules/permissions/permissions.module';
import { PositionsModule } from './modules/positions/positions.module';
import { PositionAssignmentsModule } from './modules/position-assignments/position-assignments.module';
import { RoleBindingsModule } from './modules/role-bindings/role-bindings.module';
import { SupervisionAssignmentsModule } from './modules/supervision-assignments/supervision-assignments.module';
import { ScheduleModule } from '@nestjs/schedule';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { RealnameModule } from './modules/realname/realname.module';
import { RecruitmentModule } from './modules/recruitment/recruitment.module';
import { SmsModule } from './modules/sms/sms.module';
import { TeamJoinModule } from './modules/team-join/team-join.module';
import { UsersModule } from './modules/users/users.module';
import { WechatModule } from './modules/wechat/wechat.module';

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
    // 终态 scoped-authz PR3(2026-07-01;冻结稿 §3.2/§3.3/§7.2):职务定义 + 职务规则配置面
    //   (admin/v1/positions 5 路由 + admin/v1/position-rules 4 路由;R 模式 position.* / position-rule.* 8 码)。
    PositionsModule,
    // 终态 scoped-authz PR4(2026-07-01;冻结稿 §3.4/§7.3):任职(position-assignments)双轴管理面
    //   (5 路由:组织轴列/建 + 队员轴列 + 撤销 + 历史;R 模式 position-assignment.* 4 码;任命/撤销写 audit)。
    PositionAssignmentsModule,
    // 终态 scoped-authz PR5(2026-07-01;冻结稿 §3.5/§7.4):分管(supervision-assignments)管理面
    //   (6 路由:扁平列/建/改/撤销 + 队员轴分管范围 + 组织轴被谁分管;R 模式 supervision-assignment.* 4 码;
    //    建/撤销写 audit;分管与职务正交、绝不进判权路径,closure 仅展示读非 judge)。
    SupervisionAssignmentsModule,
    // 终态 scoped-authz PR6(2026-07-01;冻结稿 §3.6/§7.5):带 scope 的角色绑定(role-bindings)管理面(第 32 模块)
    //   (4 路由:列/建 + 改/软删;R 模式 role-binding.* 4 码;建/软删写 audit)。UserRole→global RoleBinding 无损升级 =
    //    判权唯一读源(RbacService 只读 GLOBAL);scoped 绑定入库即止、绝不进判权路径(判权是 PR8 AuthzService)。
    RoleBindingsModule,
    MembersModule,
    MemberDepartmentsModule,
    MemberProfilesModule,
    EmergencyContactsModule,
    CertificatesModule,
    InsurancesModule,
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
    // 终态 scoped-authz PR8(2026-07-02;冻结稿 §5.1/§5.2/§5.3):统一判权模块(第 33 模块)。
    //   AuthzService(三源推导 + covers + ActionConstraint)+ ResourceResolverService(11 类资源归属解析);
    //   0 controller / 0 端点 / 0 新码 / 0 schema。**本刀零业务消费者**(第一个消费者 = PR9 考勤终审;
    //   explain 端点 = PR10;逐面迁移 = PR12);无 ref 判权逐字等价 rbac.can(行为锁,等价矩阵 e2e 锁定)。
    AuthzModule,
    // 终态 scoped-authz PR11(2026-07-02;冻结稿 §8.4/§11 PR11):公告导入两段式管理面(第 34 模块)。
    //   2 路由(preview 零写入诊断 + execute 幂等落库);R 模式 announcement-import.{preview,execute}.record
    //   2 码;导入本身只做锚定解析 + 编排,复用 OrganizationsService/PositionAssignmentsService/
    //   SupervisionAssignmentsService 的 create()(dryRun 沙箱哨兵驱动 preview 零写入)。0 schema。
    AnnouncementImportModule,
    // F1/A7(admin-api-fe-integration-roadmap.md §4 A7;net-new):跨资源批量 id→label 解析(第 35 模块)。
    //   1 路由 POST admin/v1/meta/resolve-labels;R 模式 meta.resolve.label 1 码(绑 ops-admin);
    //   per-type 读权限过滤(D2 复用各资源既有 .read.* 码)+ 无权/不存在静默省略(D5/R13 防枚举)。0 schema。
    MetaModule,
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
    // 微信小程序登录 T2(2026-06-12):微信通道层(settings 三端点 + 双 Provider + code2session)
    //   (冻结评审稿 docs/archive/reviews/wechat-mini-login-review.md;path /api/system/v1/wechat-settings;
    //    R 模式判权;appSecret AES-256-GCM;T3 追加认证/绑定端点,25xxx 段位届时实装)。
    WechatModule,
    // 招新一期 · 实名核验通道 T2(2026-06-18):realname 第 25 模块(settings 三端点 + 双 Provider + verify 编排)
    //   (冻结评审稿 docs/archive/reviews/recruitment-phase1-review.md;path /api/system/v1/realname-settings;
    //    R 模式判权;secretId/secretKey 两段 AES-256-GCM;27030/27031 通道码本 T2 实装;真通道休眠 DevStub 全验)。
    RealnameModule,
    // 招新一期(招新前段)T3(2026-06-18):recruitment 第 26 模块(报名 + 实名核验编排 + 临时编号 + 通知展示)
    //   (冻结评审稿 docs/archive/reviews/recruitment-phase1-review.md;surface open/v1 公开报名首用 + admin/v1 轮次/报名;
    //    R 模式判权;证件照走 storage 短 TTL signed-URL;付费实名核验为免费校验后最后一道闸;temp number 不入 members)。
    RecruitmentModule,
    // 招新三期(入队:志愿者→队员)T2(2026-06-19):team-join 第 27 模块(入队轮 CRUD + 标 gate +
    //   综合评估 + 贡献值只读汇总;冻结评审稿 docs/archive/reviews/recruitment-phase3-review.md;
    //   R 模式判权;admin/v1 surface,app 自助 T3 / 一键入队 T4;两层身份:入队才赋部门+级别)。
    TeamJoinModule,
    // CMS 内容发布模块(第 28 模块)T2(2026-06-21):content admin surface(评审稿 content-module-review.md;
    //   path /api/admin/v1/contents;R 模式判权 content.* 5 码;附件经 AttachmentsService 写路径 RBAC +
    //   content 读取面自签;状态机 draft/published/archived 立即生效无 cron;app/open 面 T3/T4 后续追加)。
    ContentModule,
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
