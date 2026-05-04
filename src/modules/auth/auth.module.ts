import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, type JwtModuleOptions, type JwtSignOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import type { JwtConfig } from '../../config/jwt.config';
import { DatabaseModule } from '../../database/database.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    // DatabaseModule 不带 @Global(),AuthService / JwtStrategy 注入 PrismaService 必须显式 import
    DatabaseModule,
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
  providers: [AuthService, JwtStrategy],
})
export class AuthModule {}
