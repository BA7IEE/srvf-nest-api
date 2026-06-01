import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { JwtConfig } from '../../config/jwt.config';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { LoginDto, LoginResponseDto, LogoutDto, RefreshTokenDto } from './auth.dto';
import {
  generateFamilyId,
  generateRefreshTokenRaw,
  hashRefreshToken,
  parseMsString,
} from './refresh-token.util';
import type { JwtPayload } from './strategies/jwt.strategy';

// 仅用于 timing 防御,不用于真实密码:
// 当 username 不存在(或软删)时仍跑一次 bcrypt.compare,保持响应耗时一致,
// 防止账号枚举(timing oracle 攻击)。
//
// 这是一个预先生成的有效 bcryptjs($2a$ + 10 rounds)hash;不在模块加载时
// hashSync,避免引入启动阻塞和不可控耗时。出处:bcryptjs 标准 hash 格式样本。
const TIMING_DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly auditLogs: AuditLogsService,
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
  // V2-D8 §12.8.2.4 受限放开 + P0-E PR-3(2026-05-18):login 成功路径在 service 内同步:
  //   - 签 access token(JwtPayload zero drift:仅 { sub, username };沿 P0-E v1 D-4)
  //   - 创建 1 行 refresh_tokens(familyId 随机 hex 32 / expiresAt = now + JWT_REFRESH_EXPIRES_IN /
  //     tokenHash = sha256(rawRefresh))+ 写 audit 'auth.login'(extra.familyId)
  //   - 响应里返 refreshToken 明文 + refreshExpiresAt ISO(沿评审稿 §3.1 D-1 + §4.1 + §5.9)
  //
  // **不动**:LoginDto schema / JwtPayload / 错误码 LOGIN_FAILED=10004 /
  //   响应包装链路 / lastLoginAt fire-and-forget / Timing dummy bcrypt /
  //   实现层依赖(禁止 import V2 模块)。
  async login(dto: LoginDto, meta: AuditMeta): Promise<LoginResponseDto> {
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

    // 5. 签 access token(payload zero drift)
    const payload: JwtPayload = { sub: user.id, username: user.username };
    const accessToken = await this.jwtService.signAsync(payload);

    const jwtCfg = this.configService.get<JwtConfig>('jwt');
    if (!jwtCfg) {
      throw new Error('jwt.config 未加载');
    }

    // 6. 计算 refresh family absolute expiration(沿评审稿 §3.1 D-1 + §3.5 D-5)
    const expiresAt = this.computeRefreshExpiresAt(jwtCfg.refreshExpiresIn);
    const familyId = generateFamilyId();

    // 7. 生成 refresh token 明文 + sha256 哈希;事务内 create refresh_tokens 行 + 写 audit
    const rawRefreshToken = generateRefreshTokenRaw();
    const tokenHash = hashRefreshToken(rawRefreshToken);
    const userIdForLog = user.id;
    const userRoleForLog = user.role;

    await this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.create({
        data: {
          userId: userIdForLog,
          tokenHash,
          familyId,
          expiresAt,
          ipFirstSeen: meta.ip,
          uaFirstSeen: meta.ua,
        },
      });
      await this.auditLogs.log({
        event: 'auth.login',
        actorUserId: userIdForLog,
        actorRoleSnap: userRoleForLog,
        resourceType: 'user',
        resourceId: userIdForLog,
        meta,
        extra: { familyId },
        tx,
      });
    });

    // 8. 顺手更新 lastLoginAt:fire-and-forget,失败只 logger.warn,不阻断响应
    void this.prisma.user
      .update({ where: { id: userIdForLog }, data: { lastLoginAt: new Date() } })
      .catch((err: unknown) => {
        this.logger.warn(
          `Failed to update lastLoginAt for user ${userIdForLog}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      });

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: jwtCfg.expiresIn,
      refreshToken: rawRefreshToken,
      refreshExpiresAt: expiresAt.toISOString(),
    };
  }

  // P0-E PR-3:POST /api/auth/v1/refresh(沿评审稿 §4.2 + §6 伪逻辑)。
  // rotation always + family revoke + absolute expiration;失败统一返 REFRESH_TOKEN_INVALID。
  //
  // 流程:
  //   1. sha256(raw) → 查 refresh_tokens.findUnique({ tokenHash })
  //   2. 不存在 / revokedAt != null / expiresAt <= now → REFRESH_TOKEN_INVALID
  //      (不区分子原因;响应体 / HTTP status / message 完全一致;沿 v1 §8 防账号枚举)
  //   3. row.rotatedAt != null(重放命中)→ family revoke + audit { replayDetected, familyRevoked }
  //      → REFRESH_TOKEN_INVALID
  //   4. user 不存在 / status !== ACTIVE / 已软删 → family revoke + REFRESH_TOKEN_INVALID
  //   5. 生成 newRaw + newHash;事务内 create 新 refresh + 标旧 refresh(rotatedAt + revokedAt +
  //      replacedById)+ 签新 access + 写 audit 'auth.refresh'
  //   6. 返回 LoginResponseDto(refreshExpiresAt 继承原 family 首个 token 的 expiresAt;absolute)
  async refresh(dto: RefreshTokenDto, meta: AuditMeta): Promise<LoginResponseDto> {
    const tokenHash = hashRefreshToken(dto.refreshToken);

    const jwtCfg = this.configService.get<JwtConfig>('jwt');
    if (!jwtCfg) {
      throw new Error('jwt.config 未加载');
    }

    // 读 row(不需要事务;后续根据 row 状态分支处理)
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        familyId: true,
        expiresAt: true,
        rotatedAt: true,
        revokedAt: true,
      },
    });

    // 失败 1:不存在 / 已过期 → 统一 REFRESH_TOKEN_INVALID(不区分子原因;
    // 沿 v1 §8 防账号枚举;响应体 / HTTP status / message 完全一致)。
    // 本路径**不写 audit**(token 不存在时无 userId / 无攻击线索;沿 P0-D LOGIN_FAILED 范式)。
    const now = new Date();
    if (!row || row.expiresAt <= now) {
      throw new BizException(BizCode.REFRESH_TOKEN_INVALID);
    }

    // 失败 2:重放命中(row 已被 rotation 过,但攻击者拿旧 raw 来 refresh)。
    // 注:rotation 路径同时设 `rotatedAt + revokedAt + revokedReason='rotated'`,
    // 所以**必须先**判断 `rotatedAt !== null`(更具体的重放语义),才能与 logout / admin-* 撤销区分。
    // 在**独立事务**内 family revoke + 写 audit;事务 commit 后再 throw,避免 throw 回滚 revoke。
    if (row.rotatedAt !== null) {
      await this.prisma.$transaction(async (tx) => {
        await this.revokeFamily(tx, row.familyId);
        await this.auditLogs.log({
          event: 'auth.refresh',
          actorUserId: row.userId,
          actorRoleSnap: null,
          resourceType: 'refresh_token',
          resourceId: row.id,
          meta,
          extra: { familyId: row.familyId, replayDetected: true, familyRevoked: true },
          tx,
        });
      });
      throw new BizException(BizCode.REFRESH_TOKEN_INVALID);
    }

    // 失败 3:row 被撤销但非 rotation(logout / admin-* 等;rotatedAt 仍 null)。
    // 不触发 family revoke(撤销已经发生过,不视为攻击),直接 INVALID。**不写 audit**。
    if (row.revokedAt !== null) {
      throw new BizException(BizCode.REFRESH_TOKEN_INVALID);
    }

    // 失败 4:user 不存在 / 已禁用 / 已软删 → 独立事务 family revoke + 写 audit + throw。
    const userCheck = await this.prisma.user.findFirst({
      where: { id: row.userId, deletedAt: null },
      select: { id: true, username: true, role: true, status: true },
    });
    if (!userCheck || userCheck.status !== UserStatus.ACTIVE) {
      await this.prisma.$transaction(async (tx) => {
        await this.revokeFamily(tx, row.familyId);
        await this.auditLogs.log({
          event: 'auth.refresh',
          actorUserId: row.userId,
          actorRoleSnap: null,
          resourceType: 'refresh_token',
          resourceId: row.id,
          meta,
          extra: { familyId: row.familyId, replayDetected: false, familyRevoked: true },
          tx,
        });
      });
      throw new BizException(BizCode.REFRESH_TOKEN_INVALID);
    }
    const user = userCheck; // alias for TS narrowing

    // 成功路径:单一事务做 rotation + audit。
    // 用 updateMany + check-and-set 防御 TOCTOU:仅当 row 仍 fresh 时才标 rotated
    // (并发 race 时第二个请求 updateMany.count = 0;通过抛 REFRESH_TOKEN_INVALID 反向告知)。
    const newRaw = generateRefreshTokenRaw();
    const newHash = hashRefreshToken(newRaw);

    // 在事务内执行;若并发命中失败,抛 REFRESH_TOKEN_INVALID(不触发 family revoke,
    // 因为这是正常用户的并发 race,不是攻击)
    const result = await this.prisma.$transaction(async (tx) => {
      const setResult = await tx.refreshToken.updateMany({
        where: { id: row.id, rotatedAt: null, revokedAt: null },
        data: {
          rotatedAt: now,
          revokedAt: now,
          revokedReason: 'rotated',
          // replacedById 在创建 newRow 后单独 update
        },
      });
      if (setResult.count === 0) {
        // 并发命中:别的请求抢先做了 rotation;不视作攻击,只返 INVALID,
        // 让客户端用 rotation 出来的新 refresh 再试
        throw new BizException(BizCode.REFRESH_TOKEN_INVALID);
      }

      const newRow = await tx.refreshToken.create({
        data: {
          userId: row.userId,
          tokenHash: newHash,
          familyId: row.familyId,
          expiresAt: row.expiresAt, // absolute:继承原 family 首个 token 的 expiresAt,不延长
          // ipFirstSeen / uaFirstSeen 不更新(它们是 login 时的快照)
        },
      });
      // 把 replacedById 补到旧 row(rotation 链可追溯)
      await tx.refreshToken.update({
        where: { id: row.id },
        data: { replacedById: newRow.id },
      });

      // 签新 access token(payload zero drift)
      const payload: JwtPayload = { sub: user.id, username: user.username };
      const accessToken = await this.jwtService.signAsync(payload);

      await this.auditLogs.log({
        event: 'auth.refresh',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: 'refresh_token',
        resourceId: row.id,
        meta,
        extra: { familyId: row.familyId, replayDetected: false },
        tx,
      });

      return {
        accessToken,
        tokenType: 'Bearer' as const,
        expiresIn: jwtCfg.expiresIn,
        refreshToken: newRaw,
        refreshExpiresAt: row.expiresAt.toISOString(),
      };
    });

    return result;
  }

  // P0-E PR-3:POST /api/auth/v1/logout(沿评审稿 §4.3 + §7.1)。
  // 幂等:不存在 / 已撤销 / 已过期 → 仍返 200;只撤销当前 row(同 family 其他链不动)。
  // access token 不消费 / 不吊销(沿 D-4);写 audit extra.found 区分真撤销 vs 幂等命中。
  async logout(dto: LogoutDto, meta: AuditMeta): Promise<null> {
    const tokenHash = hashRefreshToken(dto.refreshToken);

    await this.prisma.$transaction(async (tx) => {
      const row = await tx.refreshToken.findUnique({
        where: { tokenHash },
        select: { id: true, userId: true, revokedAt: true, expiresAt: true },
      });

      let found = false;
      const now = new Date();
      if (row && row.revokedAt === null && row.expiresAt > now) {
        await tx.refreshToken.update({
          where: { id: row.id },
          data: { revokedAt: now, revokedReason: 'logout' },
        });
        found = true;
      }

      await this.auditLogs.log({
        event: 'auth.logout',
        actorUserId: row?.userId ?? null,
        actorRoleSnap: null,
        resourceType: 'refresh_token',
        resourceId: row?.id ?? null,
        meta,
        extra: { found },
        tx,
      });
    });

    return null;
  }

  // P0-E PR-3:POST /api/auth/v1/logout-all(沿评审稿 §4.4 + §7.2)。
  // 走 JwtAuthGuard;撤销该 user 全部未过期且未撤销的 refresh token。
  // access token 不主动吊销(沿 D-4);返 { revokedCount }(0 也写 audit,幂等场景)。
  async logoutAll(
    currentUser: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<{ revokedCount: number }> {
    const now = new Date();
    const revokedCount = await this.prisma.$transaction(async (tx) => {
      const updateResult = await tx.refreshToken.updateMany({
        where: { userId: currentUser.id, revokedAt: null, expiresAt: { gt: now } },
        data: { revokedAt: now, revokedReason: 'logout' },
      });
      await this.auditLogs.log({
        event: 'auth.logout-all',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'user',
        resourceId: currentUser.id,
        meta,
        extra: { revokedCount: updateResult.count },
        tx,
      });
      return updateResult.count;
    });

    return { revokedCount };
  }

  // family revoke helper:refresh 重放命中 / refresh 时 user inactive 场景共用。
  // 在同一事务内 updateMany,沿 v1 assertNotLastSuperAdmin 范式。
  private async revokeFamily(tx: PrismaTx, familyId: string): Promise<void> {
    await tx.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'family-revoked' },
    });
  }

  // 计算 family absolute expiration:JWT_REFRESH_EXPIRES_IN ms 字符串 → Date(now + ttlMs)。
  // 启动时由 jwt.config 验证 refreshExpiresIn 已设置;此处不合法 ms 字符串再抛一次防御性错误。
  private computeRefreshExpiresAt(refreshExpiresIn: string): Date {
    const ttlMs = parseMsString(refreshExpiresIn);
    if (ttlMs === null) {
      throw new Error(
        `JWT_REFRESH_EXPIRES_IN 无效:"${refreshExpiresIn}",必须是合法 ms 字符串(如 '90d' / '1h' / '30m' / '60s' / '500ms')`,
      );
    }
    return new Date(Date.now() + ttlMs);
  }
}
