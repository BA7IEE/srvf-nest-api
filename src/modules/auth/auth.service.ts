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

  // 防账号枚举失败场景统一抛 LOGIN_FAILED(详见 CLAUDE.md §8 + V2-D8 §12.8.2.3 +
  // docs/v2-api-contract.md §6.6.3 失败场景表):
  //   1) 输入值在 username 与 memberNo 两条查找路径下均未命中
  //   2) memberNo 命中 member,但 member 未绑定 user(users.memberId 反查为 null)
  //   3) memberNo 命中 member,但 member 已软删(视作未命中)
  //   4) 命中 user 但 status=DISABLED / deletedAt!=null
  //   5) 命中 user 但 bcrypt.compare 失败
  // Timing 防御:任一场景**必须**跑一次 bcrypt.compare(命中走真 hash,未命中走 dummy)。
  //
  // V2-D8 §12.8.2.4 唯一受限放开:本方法是 v1 src/ 在 V2 第一阶段唯一允许的扩展,
  // 仅扩展服务端查找路径加 memberNo 回退,**不**改:
  //   - LoginDto schema(入参字段名 / 类型 / 校验装饰器全保留)
  //   - 出参 LoginResponseDto schema
  //   - 错误码 LOGIN_FAILED = 10004
  //   - 响应包装链路 / JwtService.sign 调用方式 / lastLoginAt 顺手更新
  //   - Timing dummy bcrypt 机制(强制扩展到新增 memberNo 路径)
  //   - 实现层依赖:必须通过 PrismaService 直读 member 表,**禁止** import
  //     MembersModule / MembersService / V2 BizCode 段位常量(防 v1 → V2 循环依赖)
  async login(dto: LoginDto): Promise<LoginResponseDto> {
    const usernameNormalized = dto.username.trim().toLowerCase();
    // memberNo 查找用 trim 后**原大小写**(与 username toLowerCase 不同 — 编号即身份)
    const memberNoCandidate = dto.username.trim();

    // 1. 先按 username 查 user(沿用 v1 现有规则)
    let user = await this.prisma.user.findFirst({
      where: { username: usernameNormalized, deletedAt: null },
    });

    // 2. username 未命中 → 按 memberNo 查 member,若 member 活跃且绑定 user → 反查 user
    if (!user) {
      // findUnique 包含全表(memberNo 全局唯一不复用,可能拿到软删 member);
      // 软删 member 视作未命中(对应 contract §6.6.5 e2e bullet 6)。
      const member = await this.prisma.member.findUnique({
        where: { memberNo: memberNoCandidate },
        select: { id: true, deletedAt: true },
      });
      if (member && member.deletedAt === null) {
        // member 活跃 → 反查 user。findFirst 含 deletedAt 过滤;若 user.memberId
        // 关联到的 user 不存在 / 已软删 → user 仍为 null,后续走 dummy bcrypt。
        user = await this.prisma.user.findFirst({
          where: { memberId: member.id, deletedAt: null },
        });
      }
    }

    // 3. 任一路径**必须**跑一次 bcrypt.compare(timing 防御 + dummy 扩展)
    const passwordOk = await bcrypt.compare(dto.password, user?.passwordHash ?? TIMING_DUMMY_HASH);

    // 4. 失败统一抛 LOGIN_FAILED(响应体 / HTTP status / message 完全一致)
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
