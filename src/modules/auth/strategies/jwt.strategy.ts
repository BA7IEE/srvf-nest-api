import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { UserStatus } from '@prisma/client';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { CurrentUserPayload } from '../../../common/decorators/current-user.decorator';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { BizException } from '../../../common/exceptions/biz.exception';
import type { JwtConfig } from '../../../config/jwt.config';
import { PrismaService } from '../../../database/prisma.service';

// JwtPayload 固定为最小结构(详见 ARCHITECTURE.md §7.6):
// 不塞 role,不塞完整用户对象。每请求查库取最新 role / status。
export interface JwtPayload {
  sub: string;
  username: string;
}

// JwtStrategy:每请求根据 payload.sub 查库,校验 deletedAt === null && status === ACTIVE。
// 任何校验失败统一抛 BizException(UNAUTHORIZED) → AllExceptionsFilter 转
// HTTP 401 + { code: 40100, message: '未登录或登录已失效', data: null }。
//
// 这是 v1 唯一的鉴权阶段查库点;JwtAuthGuard 不应再写一份查库逻辑。
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const jwtCfg = configService.get<JwtConfig>('jwt');
    if (!jwtCfg) {
      throw new Error('jwt.config 未加载');
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtCfg.secret,
    });
  }

  async validate(payload: JwtPayload): Promise<CurrentUserPayload> {
    const user = await this.prisma.user.findFirst({
      where: { id: payload.sub, deletedAt: null },
      select: { id: true, username: true, role: true, status: true },
    });
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new BizException(BizCode.UNAUTHORIZED);
    }
    return user;
  }
}
