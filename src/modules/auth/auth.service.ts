import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, UserStatus, type Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { JwtConfig } from '../../config/jwt.config';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { LoginDto, LoginResponseDto, LogoutDto, RefreshTokenDto } from './auth.dto';
import { lockAuthSessionUser } from './auth-session-lock';
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

export type SessionIssuanceExpectation =
  | { kind: 'password-hash'; value: string }
  | { kind: 'phone'; value: string }
  | { kind: 'openid'; value: string };

type SessionUserSnapshot = {
  id: string;
  username: string;
  role: Role;
  status: UserStatus;
  deletedAt: Date | null;
  passwordHash: string;
  phone: string | null;
  openid: string | null;
};

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

    // 5-8. 会话签发：三种登录继续共用 createSession；D-PR1 起额外传入锁外已验证
    // factor snapshot，由唯一 User 行锁后的权威快照决定是否允许签发。
    return this.createSession(
      user.id,
      { kind: 'password-hash', value: user.passwordHash },
      meta,
      'auth.login',
    );
  }

  // 会话签发(评审稿 E-O6 + D-PR1):
  //   5. 锁 User，重读 ACTIVE/deletedAt/factor/username/role，拒绝 stale factor
  //   6. 按锁后 username 签 access token(JwtPayload zero drift:仅 { sub, username })
  //   7. 事务内 create refresh_tokens 行 + 写 audit(event 由调用方传入)
  //   8. lastLoginAt fire-and-forget
  // 调用方:login()(event='auth.login',extra 仅 familyId)/
  //         LoginSmsService.login()(event='auth.login.sms',extra 追加 phone 掩码 + codeId)/
  //         LoginWechatService(event='auth.login.wechat',extra 追加 openid 掩码,
  //         绑定路径另含 phone 掩码 + codeId;2026-06-12 wechat 评审稿 E-15,union 扩展仅类型行)。
  // extraAudit 仅允许追加非敏感字段(掩码后手机号 / 掩码后 openid / codeId);
  // 禁明文码 / token / hash / session_key 任何形态。
  async createSession(
    userId: string,
    expectation: SessionIssuanceExpectation,
    meta: AuditMeta,
    event: 'auth.login' | 'auth.login.sms' | 'auth.login.wechat',
    extraAudit?: Record<string, string | number | null>,
  ): Promise<LoginResponseDto> {
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
    const result = await this.prisma.$transaction(async (tx) => {
      const locked = await lockAuthSessionUser(tx, userId);
      const current = locked
        ? await tx.user.findUnique({
            where: { id: userId },
            select: {
              id: true,
              username: true,
              role: true,
              status: true,
              deletedAt: true,
              passwordHash: true,
              phone: true,
              openid: true,
            },
          })
        : null;
      if (!current || !this.matchesSessionExpectation(current, expectation)) {
        throw new BizException(this.sessionIssuanceFailureCode(expectation));
      }

      // 签 access token(payload zero drift)；username / role 使用锁后权威快照。
      const payload: JwtPayload = { sub: current.id, username: current.username };
      const accessToken = await this.jwtService.signAsync(payload);

      await tx.refreshToken.create({
        data: {
          userId: current.id,
          tokenHash,
          familyId,
          expiresAt,
          ipFirstSeen: meta.ip,
          uaFirstSeen: meta.ua,
        },
      });
      await this.auditLogs.log({
        event,
        actorUserId: current.id,
        actorRoleSnap: current.role,
        resourceType: 'user',
        resourceId: current.id,
        meta,
        extra: { familyId, ...extraAudit },
        tx,
      });

      return {
        accessToken,
        tokenType: 'Bearer' as const,
        expiresIn: jwtCfg.expiresIn,
        refreshToken: rawRefreshToken,
        refreshExpiresAt: expiresAt.toISOString(),
      };
    });

    // 8. 顺手更新 lastLoginAt:fire-and-forget,失败只 logger.warn,不阻断响应
    void this.prisma.user
      .update({ where: { id: userId }, data: { lastLoginAt: new Date() } })
      .catch((err: unknown) => {
        this.logger.warn(
          `Failed to update lastLoginAt for user ${userId}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      });

    return result;
  }

  private matchesSessionExpectation(
    user: SessionUserSnapshot,
    expectation: SessionIssuanceExpectation,
  ): boolean {
    if (user.deletedAt !== null || user.status !== UserStatus.ACTIVE) return false;
    switch (expectation.kind) {
      case 'password-hash':
        return user.passwordHash === expectation.value;
      case 'phone':
        return user.phone === expectation.value;
      case 'openid':
        return user.openid === expectation.value;
    }
  }

  private sessionIssuanceFailureCode(expectation: SessionIssuanceExpectation) {
    switch (expectation.kind) {
      case 'password-hash':
        return BizCode.LOGIN_FAILED;
      case 'phone':
        return BizCode.SMS_CODE_INVALID;
      case 'openid':
        return BizCode.WECHAT_CODE_INVALID;
    }
  }

  // P0-E PR-3:POST /api/auth/v1/refresh(沿评审稿 §4.2 + §6 伪逻辑)。
  // rotation always + family revoke + absolute expiration;失败统一返 REFRESH_TOKEN_INVALID。
  //
  // 流程:
  //   1. sha256(raw) → 锁外查 refresh row，仅定位 userId 并记录请求到达时的 rotated 状态
  //   2. 不存在 / 过期 / 非 rotation 撤销 → 统一 REFRESH_TOKEN_INVALID
  //   3. 锁 User → 事务内重读 refresh row；锁外已观察 rotated 才按 replay revoke family
  //   4. 锁等待期间被正常 rotation/revoke 改写的 fresh 请求仅作为竞争输家返 10007
  //   5. 重读 User ACTIVE/未软删后 CAS rotate、insert sibling、签 access、写 audit
  //   6. 返回 LoginResponseDto(refreshExpiresAt 继承原 family absolute expiresAt)
  async refresh(dto: RefreshTokenDto, meta: AuditMeta): Promise<LoginResponseDto> {
    const tokenHash = hashRefreshToken(dto.refreshToken);

    const jwtCfg = this.configService.get<JwtConfig>('jwt');
    if (!jwtCfg) {
      throw new Error('jwt.config 未加载');
    }

    // 锁外只做定位，并保存“请求到达时是否已经 rotated”的 observed state。
    // 后者用于区分真实 replay 与两个 fresh refresh 请求在 User 锁上的正常竞争。
    const observed = await this.prisma.refreshToken.findUnique({
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
    if (!observed || observed.expiresAt <= now) {
      throw new BizException(BizCode.REFRESH_TOKEN_INVALID);
    }
    const replayObserved = observed.rotatedAt !== null;
    if (!replayObserved && observed.revokedAt !== null) {
      throw new BizException(BizCode.REFRESH_TOKEN_INVALID);
    }

    const newRaw = generateRefreshTokenRaw();
    const newHash = hashRefreshToken(newRaw);

    const result = await this.prisma.$transaction(async (tx) => {
      if (!(await lockAuthSessionUser(tx, observed.userId))) return null;

      const row = await tx.refreshToken.findUnique({
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
      const lockedNow = new Date();
      if (!row || row.expiresAt <= lockedNow) return null;

      // 请求在等待 User 锁之前就已经观察到 rotated ancestor，才属于 replay。
      // revoke + audit 必须提交后再由事务外统一抛 10007。
      if (replayObserved) {
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
        return null;
      }

      // fresh 请求等待锁期间若已被另一 rotation 或 revoke 改写，只是正常竞争输家。
      if (row.rotatedAt !== null || row.revokedAt !== null) return null;

      const user = await tx.user.findUnique({
        where: { id: row.userId },
        select: { id: true, username: true, role: true, status: true, deletedAt: true },
      });
      if (!user || user.deletedAt !== null || user.status !== UserStatus.ACTIVE) {
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
        return null;
      }

      const setResult = await tx.refreshToken.updateMany({
        where: { id: row.id, rotatedAt: null, revokedAt: null },
        data: {
          rotatedAt: lockedNow,
          revokedAt: lockedNow,
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

    if (!result) throw new BizException(BizCode.REFRESH_TOKEN_INVALID);
    return result;
  }

  // Identity Session P0 PR2:POST /api/auth/v1/logout(沿冻结评审稿 §4.8)。
  // 幂等:不存在 / 已过期 / family 已全撤 → 仍返 200;可识别且未过期的 row(含 rotated
  // ancestor)只用于定位 family,同事务撤销该 family 全部活跃未过期 token。
  // access token 不消费 / 不吊销;仅真实状态变化写 audit,未知/失效 token 零留痕。
  async logout(dto: LogoutDto, meta: AuditMeta): Promise<null> {
    const tokenHash = hashRefreshToken(dto.refreshToken);

    const observed = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      select: { userId: true, expiresAt: true },
    });
    if (!observed || observed.expiresAt <= new Date()) return null;

    await this.prisma.$transaction(async (tx) => {
      if (!(await lockAuthSessionUser(tx, observed.userId))) return;
      const row = await tx.refreshToken.findUnique({
        where: { tokenHash },
        select: { id: true, userId: true, familyId: true, expiresAt: true },
      });

      const now = new Date();
      if (!row || row.expiresAt <= now) return;

      const updateResult = await tx.refreshToken.updateMany({
        where: { familyId: row.familyId, revokedAt: null, expiresAt: { gt: now } },
        data: { revokedAt: now, revokedReason: 'logout' },
      });
      if (updateResult.count === 0) return;

      await this.auditLogs.log({
        event: 'auth.logout',
        actorUserId: row.userId,
        actorRoleSnap: null,
        resourceType: 'refresh_token',
        resourceId: row.id,
        meta,
        extra: { familyId: row.familyId, revokedCount: updateResult.count },
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
      if (!(await lockAuthSessionUser(tx, currentUser.id))) return 0;
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
