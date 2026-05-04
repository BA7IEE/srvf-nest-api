import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UserStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { JwtConfig } from '../../config/jwt.config';
import { PrismaService } from '../../database/prisma.service';
import type { LoginDto, LoginResponseDto } from './auth.dto';
import type { JwtPayload } from './strategies/jwt.strategy';

// 仅用于 timing 防御,不用于真实密码:
// 当 username 不存在(或软删)时仍跑一次 bcrypt.compare,保持响应耗时一致,
// 防止账号枚举(timing oracle 攻击)。
//
// 这是一个预先生成的有效 bcryptjs($2a$ + 10 rounds)hash;不在模块加载时
// hashSync,避免引入启动阻塞和不可控耗时。出处:bcryptjs 标准 hash 格式样本。
const TIMING_DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  // 防账号枚举四场景统一抛 LOGIN_FAILED(详见 CLAUDE.md §8):
  //   1) username 不存在
  //   2) password 错误
  //   3) 账号已禁用(status=DISABLED)
  //   4) 账号已软删除(deletedAt != null)
  // Timing 防御:四种场景都跑一次 bcrypt.compare(慢操作),响应耗时一致。
  async login(dto: LoginDto): Promise<LoginResponseDto> {
    const username = dto.username.trim().toLowerCase();

    const user = await this.prisma.user.findFirst({
      where: { username, deletedAt: null },
    });

    // 即使 user 为 null 也跑 compare(配 dummy hash),保证 timing 一致
    const passwordOk = await bcrypt.compare(dto.password, user?.passwordHash ?? TIMING_DUMMY_HASH);

    if (!user || !passwordOk || user.status !== UserStatus.ACTIVE) {
      throw new BizException(BizCode.LOGIN_FAILED);
    }

    const payload: JwtPayload = { sub: user.id, username: user.username };
    const accessToken = await this.jwtService.signAsync(payload);

    // 顺手更新 lastLoginAt:fire-and-forget,失败只 logger.warn,不阻断响应
    void this.prisma.user
      .update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
      .catch((err: unknown) => {
        this.logger.warn(
          `Failed to update lastLoginAt for user ${user.id}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      });

    const jwtCfg = this.configService.get<JwtConfig>('jwt');
    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: jwtCfg?.expiresIn ?? '',
    };
  }
}
