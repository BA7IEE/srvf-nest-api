import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, type JwtModuleOptions, type JwtSignOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import type { JwtConfig } from '../../config/jwt.config';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { SmsModule } from '../sms/sms.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordResetService } from './password-reset.service';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    // DatabaseModule 不带 @Global(),AuthService / JwtStrategy 注入 PrismaService 必须显式 import
    DatabaseModule,
    // P0-E PR-3(2026-05-18):AuthService.login / refresh / logout / logoutAll 在事务内写 audit
    // 'auth.login' / 'auth.refresh' / 'auth.logout' / 'auth.logout-all'(沿评审稿 §5.9);
    // 沿 P0-D UsersModule.imports: AuditLogsModule 范式。
    AuditLogsModule,
    // 找回密码 T2(2026-06-11):PasswordResetService 消费 SmsCodeService
    // (assertValid / verifyAndConsume / issue;评审稿 password-reset-by-sms-review.md E-1/E-6)。
    SmsModule,
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService): JwtModuleOptions => {
        const jwtCfg = configService.get<JwtConfig>('jwt');
        if (!jwtCfg) {
          throw new Error('jwt.config 未加载');
        }
        // jsonwebtoken 运行时接受 '7d' 这类 ms 兼容字符串,但其 TS 类型从
        // jsonwebtoken 9 起收紧到 ms.StringValue 字面量;这里 cast 让运行时
        // 合法、来自 .env 的 string 通过编译。
        const signOptions: JwtSignOptions = {
          expiresIn: jwtCfg.expiresIn as JwtSignOptions['expiresIn'],
        };
        return { secret: jwtCfg.secret, signOptions };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, PasswordResetService, JwtStrategy],
})
export class AuthModule {}
