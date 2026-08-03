import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, type JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import type { JwtConfig } from '../../config/jwt.config';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { SmsModule } from '../sms/sms.module';
import { WechatModule } from '../wechat/wechat.module';
import { WecomModule } from '../wecom/wecom.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { IdentityStepUpService } from './identity-step-up.service';
import { LoginSmsService } from './login-sms.service';
import { LoginWechatService } from './login-wechat.service';
import { LoginWecomService } from './login-wecom.service';
import { WecomLoginFailureGate } from './wecom-login-failure.gate';
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
    // 微信小程序登录 T3(2026-06-12):LoginWechatService 消费 WechatService.code2session
    // (wechat-mini-login-review.md E-14;绑定锚点仍走上面 SmsModule 的 SmsCodeService)。
    WechatModule,
    // 企业微信接入 T3(2026-08-02):LoginWecomService 消费 WecomService(闸门链 + code 换身份)
    // 与 WecomAuthAttemptService(state / ticket 台账);冻结稿 §4.2 依赖方向 `auth → wecom`,
    // 单向无环 —— wecom 模块对 User / Member / 业务权限无感知,身份占用与 Audit 全留在本模块。
    WecomModule,
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService): JwtModuleOptions => {
        const jwtCfg = configService.get<JwtConfig>('jwt');
        if (!jwtCfg) {
          throw new Error('jwt.config 未加载');
        }
        const signOptions = { expiresIn: jwtCfg.expiresInSeconds };
        return { secret: jwtCfg.secret, signOptions };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordResetService,
    LoginSmsService,
    LoginWechatService,
    LoginWecomService,
    // P1-27 第一刀 B3:36010 的唯一归一化出口。做成 provider 是为了让
    // "每一条 36010 都确实经过它"这件事能被单测 spy 出来(判据要可机器核对)。
    WecomLoginFailureGate,
    IdentityStepUpService,
    JwtStrategy,
  ],
  exports: [IdentityStepUpService],
})
export class AuthModule {}
