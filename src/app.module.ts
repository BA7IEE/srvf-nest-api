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
import appConfig from './config/app.config';
import type { AppConfig } from './config/app.config';
import databaseConfig from './config/database.config';
import jwtConfig from './config/jwt.config';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { DictionariesModule } from './modules/dictionaries/dictionaries.module';
import { EmergencyContactsModule } from './modules/emergency-contacts/emergency-contacts.module';
import { HealthModule } from './modules/health/health.module';
import { MemberDepartmentsModule } from './modules/member-departments/member-departments.module';
import { MemberProfilesModule } from './modules/member-profiles/member-profiles.module';
import { MembersModule } from './modules/members/members.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
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
