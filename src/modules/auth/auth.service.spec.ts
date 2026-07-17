import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import { Role, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { JwtConfig } from '../../config/jwt.config';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { LoginDto } from './auth.dto';
import { AuthService } from './auth.service';
import { hashRefreshToken } from './refresh-token.util';

jest.mock('bcryptjs');

// auth service-level characterization spec(B 档 test-only,scoped;沿 srvf-god-service-refactor
// + srvf-auth-security)。锁定 `auth.service.ts` login / createSession / refresh / logout /
// logoutAll 5 方法的「编排契约」现状行为(安全敏感:防枚举 timing dummy / JwtPayload 最小化 /
// refresh rotation + reuse 检测 family revoke + check-and-set 输家分支 / 幂等 logout)。
// 此前本 service 零 unit spec(仅 refresh-token.util.spec.ts 测纯函数 + auth e2e 全组)。
//
// 风格沿 src/modules/users/users.service.spec.ts(同为安全敏感 + bcryptjs 桩)
//      + src/modules/certificates/certificates.service.spec.ts:
// - 纯构造器注入 mock(prisma / jwtService / configService / auditLogs),不起 Nest、不连库。
// - auth 仅回调式 `$transaction`;mock 把 prisma 自身当 tx 传入(audit 断言 `tx: prisma` 锁接线)。
// - `bcryptjs` 是模块级 import(非注入),用 `jest.mock` 桩 compare:锁「任一失败场景必跑一次
//   compare」的 timing 契约与入参(真 hash / dummy hash),不测真实哈希强度。
// - refresh-token.util 纯函数**不桩**(随机生成 / sha256 确定性已由 refresh-token.util.spec.ts
//   锁定);本 spec 借 `hashRefreshToken` 断言「响应明文 ↔ 入库 hash」一致(明文不入库)。
//
// 边界(本 spec 只到 service 编排层;不改任何业务代码 / BizCode / audit event 名 / 既有断言):
// - **不**测 HTTP / Guard / 限流装饰器 / Prisma 集成 / 真实并发 race(归 auth-*.e2e 全组)。
// - **不**测 password-reset.service / login-sms.service(独立类,非本 service;OTP 登录与密码
//   登录的同构性由两者共用的 createSession 用例 + 各自 e2e 锁定)。
// - **不**断言 JWT 真实签名 / 过期语义(jwtService 桩;归 JwtModule 配置 + e2e)。
// - **不**断言 audit 落库行形 / context 结构(归 audit-logs.service.spec + e2e);只锁 event 名 /
//   actor / resource / extra 白名单字段 / tx 接线。

const bcryptMock = jest.mocked(bcrypt);

// ============ 固定 fixture ============

const META: AuditMeta = { requestId: 'req-auth-1', ip: '10.0.0.1', ua: 'jest' };

// service 只读 expiresIn / refreshExpiresIn;secret 由 JwtModule 消费,此处不参与。
const JWT_CFG: JwtConfig = {
  secret: 'unit-test-jwt-secret-not-used-by-service',
  expiresIn: '15m',
  refreshExpiresIn: '90d',
};
const TTL_90D_MS = 90 * 24 * 60 * 60 * 1000;

// refresh / logout 用的固定明文与其 sha256(查询按 hash 命中;「hash 不符」≡ findUnique 未命中)。
const OLD_RAW = 'old-raw-refresh-token-fixture';
const OLD_HASH = hashRefreshToken(OLD_RAW);

function minutesFromNow(min: number): Date {
  return new Date(Date.now() + min * 60_000);
}

// ============ 行形 ============

// login 路径 findFirst 无 select(全行);service 实际只读这 5 字段。
interface LoginUserRow {
  id: string;
  username: string;
  passwordHash: string;
  role: Role;
  status: UserStatus;
}

function makeLoginUser(overrides: Partial<LoginUserRow> = {}): LoginUserRow {
  return {
    id: 'u-1',
    username: 'alice',
    passwordHash: 'stored-bcrypt-hash',
    role: Role.USER,
    status: UserStatus.ACTIVE,
    ...overrides,
  };
}

// refresh 路径 findUnique select 6 字段锁形(logout select 为其 4 字段子集,复用同行形)。
interface RefreshRow {
  id: string;
  userId: string;
  familyId: string;
  expiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
}

function makeRefreshRow(overrides: Partial<RefreshRow> = {}): RefreshRow {
  return {
    id: 'rt-1',
    userId: 'u-1',
    familyId: 'fam-1',
    expiresAt: minutesFromNow(60 * 24), // 默认未过期(+1d)
    rotatedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function makeCurrentUser(overrides: Partial<CurrentUserPayload> = {}): CurrentUserPayload {
  return {
    id: 'admin-1',
    username: 'admin',
    role: Role.ADMIN,
    status: UserStatus.ACTIVE,
    memberId: null,
    ...overrides,
  };
}

function makeLoginDto(overrides: Partial<LoginDto> = {}): LoginDto {
  return { username: 'alice', password: 'Secret123', ...overrides };
}

// ============ mock 工厂 ============

function makePrismaMock() {
  const user = {
    findFirst: jest.fn<Promise<LoginUserRow | null>, [unknown]>(),
    // lastLoginAt fire-and-forget 在返回值上挂 .catch;默认必须 resolve,避免假 TypeError。
    update: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({}),
  };
  const member = {
    findUnique: jest
      .fn<Promise<{ id: string; deletedAt: Date | null } | null>, [unknown]>()
      .mockResolvedValue(null),
  };
  const refreshToken = {
    findUnique: jest.fn<Promise<RefreshRow | null>, [unknown]>(),
    create: jest.fn<Promise<{ id: string }>, [unknown]>(),
    update: jest.fn<Promise<unknown>, [unknown]>(),
    updateMany: jest.fn<Promise<{ count: number }>, [unknown]>(),
  };
  const $transaction = jest.fn<Promise<unknown>, [unknown]>();
  const prisma = { user, member, refreshToken, $transaction };
  // auth 仅回调式:把 prisma mock 自身当 tx 传入;callback 抛错原样向外传播(与真 $transaction 同构)。
  $transaction.mockImplementation((arg: unknown) =>
    (arg as (tx: typeof prisma) => Promise<unknown>)(prisma),
  );
  return prisma;
}
type PrismaMock = ReturnType<typeof makePrismaMock>;

function makeAuditLogsMock() {
  return { log: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined) };
}
type AuditLogsMock = ReturnType<typeof makeAuditLogsMock>;

function makeJwtMock() {
  return {
    signAsync: jest.fn<Promise<string>, [unknown]>().mockResolvedValue('signed.access.jwt'),
  };
}
type JwtMock = ReturnType<typeof makeJwtMock>;

function makeConfigMock() {
  return { get: jest.fn<JwtConfig | undefined, [string]>().mockReturnValue(JWT_CFG) };
}
type ConfigMock = ReturnType<typeof makeConfigMock>;

function makeService(
  prisma: PrismaMock,
  opts: { auditLogs?: AuditLogsMock; jwt?: JwtMock; config?: ConfigMock } = {},
): AuthService {
  const auditLogs = opts.auditLogs ?? makeAuditLogsMock();
  const jwt = opts.jwt ?? makeJwtMock();
  const config = opts.config ?? makeConfigMock();
  return new AuthService(
    prisma as unknown as PrismaService,
    jwt as unknown as JwtService,
    config as unknown as ConfigService,
    auditLogs as unknown as AuditLogsService,
  );
}

describe('AuthService (characterization, scoped)', () => {
  // 静默 lastLoginAt fire-and-forget 失败路径的 logger.warn(不污染测试输出;
  // 沿 certificates.service.spec.ts Logger silence 范式)。
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    // bcrypt 桩默认「密码不匹配」;成功路径用例内显式改 true。
    bcryptMock.compare.mockReset();
    bcryptMock.compare.mockResolvedValue(false as never);
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  // ============ 1. login — 防枚举统一失败 + timing dummy ============
  describe('login — 防枚举统一失败 + timing dummy', () => {
    it('成功(username 路径)→ trim+lowercase 归一查询;返 LoginResponseDto 恰 5 字段;audit auth.login', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      const jwt = makeJwtMock();
      prisma.user.findFirst.mockResolvedValue(makeLoginUser());
      bcryptMock.compare.mockResolvedValue(true as never);
      const service = makeService(prisma, { auditLogs, jwt });

      const res = await service.login(makeLoginDto({ username: '  Alice ' }), META);

      // username 归一:trim + toLowerCase;软删用户在查询层即被过滤
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { username: 'alice', deletedAt: null },
      });
      // username 命中 → 不走 memberNo 回查
      expect(prisma.member.findUnique).not.toHaveBeenCalled();
      // 真 hash 参与比对
      expect(bcryptMock.compare).toHaveBeenCalledWith('Secret123', 'stored-bcrypt-hash');
      // 响应恰 5 字段(LoginResponseDto 字段集封板,禁止再增)
      expect(Object.keys(res).sort()).toEqual([
        'accessToken',
        'expiresIn',
        'refreshExpiresAt',
        'refreshToken',
        'tokenType',
      ]);
      expect(res.accessToken).toBe('signed.access.jwt');
      expect(res.tokenType).toBe('Bearer');
      expect(res.expiresIn).toBe('15m');
      expect(auditLogs.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'auth.login',
          actorUserId: 'u-1',
          actorRoleSnap: Role.USER,
          resourceType: 'user',
          resourceId: 'u-1',
          meta: META,
          tx: prisma,
        }),
      );
    });

    it('防枚举①用户不存在(username + memberNo 双路径未命中)→ LOGIN_FAILED;仍跑一次 dummy bcrypt.compare', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      const jwt = makeJwtMock();
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.member.findUnique.mockResolvedValue(null);
      const service = makeService(prisma, { auditLogs, jwt });

      await expect(
        service.login(makeLoginDto({ username: 'ghost', password: 'AnyPwd123' }), META),
      ).rejects.toEqual(new BizException(BizCode.LOGIN_FAILED));

      // 双路径都查过(memberNo 候选 = trim 后原值)
      expect(prisma.member.findUnique).toHaveBeenCalledWith({
        where: { memberNo: 'ghost' },
        select: { id: true, deletedAt: true },
      });
      // timing 防御:未命中也必须恰好跑一次 compare,且第二参是 bcrypt 格式 dummy hash
      expect(bcryptMock.compare).toHaveBeenCalledTimes(1);
      expect(bcryptMock.compare).toHaveBeenCalledWith(
        'AnyPwd123',
        expect.stringMatching(/^\$2a\$10\$/),
      );
      // 无签发 / 无事务 / 无审计 / 无任何写
      expect(jwt.signAsync).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      expect(auditLogs.log).not.toHaveBeenCalled();
    });

    it('防枚举②密码错 → 同一 LOGIN_FAILED;compare 跑的是真 hash;无签发无审计', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      const jwt = makeJwtMock();
      prisma.user.findFirst.mockResolvedValue(makeLoginUser());
      bcryptMock.compare.mockResolvedValue(false as never);
      const service = makeService(prisma, { auditLogs, jwt });

      await expect(service.login(makeLoginDto({ password: 'WrongPwd1' }), META)).rejects.toEqual(
        new BizException(BizCode.LOGIN_FAILED),
      );

      expect(bcryptMock.compare).toHaveBeenCalledTimes(1);
      expect(bcryptMock.compare).toHaveBeenCalledWith('WrongPwd1', 'stored-bcrypt-hash');
      expect(jwt.signAsync).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(auditLogs.log).not.toHaveBeenCalled();
    });

    it('防枚举③DISABLED → 同一 LOGIN_FAILED,即使密码正确;compare 仍先跑完(真 hash)', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      const jwt = makeJwtMock();
      prisma.user.findFirst.mockResolvedValue(makeLoginUser({ status: UserStatus.DISABLED }));
      bcryptMock.compare.mockResolvedValue(true as never);
      const service = makeService(prisma, { auditLogs, jwt });

      await expect(service.login(makeLoginDto(), META)).rejects.toEqual(
        new BizException(BizCode.LOGIN_FAILED),
      );

      expect(bcryptMock.compare).toHaveBeenCalledTimes(1);
      expect(bcryptMock.compare).toHaveBeenCalledWith('Secret123', 'stored-bcrypt-hash');
      expect(jwt.signAsync).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(auditLogs.log).not.toHaveBeenCalled();
    });

    it('防枚举④软删 → 查询 where 锁 deletedAt:null(软删即未命中)→ dummy compare + 同一 LOGIN_FAILED', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      // 软删用户:findFirst({ deletedAt: null })在 DB 层即过滤 → 返 null,走与「不存在」相同的路径
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.member.findUnique.mockResolvedValue(null);
      const service = makeService(prisma, { auditLogs });

      await expect(service.login(makeLoginDto({ username: 'deleted_user' }), META)).rejects.toEqual(
        new BizException(BizCode.LOGIN_FAILED),
      );

      // 软删不可登录由查询条件锁定(而非内存判断)
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { username: 'deleted_user', deletedAt: null },
      });
      expect(bcryptMock.compare).toHaveBeenCalledTimes(1);
      expect(bcryptMock.compare).toHaveBeenCalledWith(
        'Secret123',
        expect.stringMatching(/^\$2a\$10\$/),
      );
      expect(auditLogs.log).not.toHaveBeenCalled();
    });

    it('memberNo 回查路径:username 未命中 → memberNo(trim 原大小写)→ 活跃 member 反查 user → 成功', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.user.findFirst
        .mockResolvedValueOnce(null) // 第 1 次:username 路径未命中
        .mockResolvedValueOnce(makeLoginUser({ id: 'u-2', username: 'bob' })); // 第 2 次:memberId 反查命中
      prisma.member.findUnique.mockResolvedValue({ id: 'mem-1', deletedAt: null });
      bcryptMock.compare.mockResolvedValue(true as never);
      const service = makeService(prisma, { auditLogs });

      const res = await service.login(makeLoginDto({ username: ' SR-001 ' }), META);

      // memberNo 用 trim 后原大小写(编号即身份,与 username toLowerCase 不同)
      expect(prisma.member.findUnique).toHaveBeenCalledWith({
        where: { memberNo: 'SR-001' },
        select: { id: true, deletedAt: true },
      });
      expect(prisma.user.findFirst).toHaveBeenNthCalledWith(2, {
        where: { memberId: 'mem-1', deletedAt: null },
      });
      expect(res.accessToken).toBe('signed.access.jwt');
      expect(auditLogs.log).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'auth.login', actorUserId: 'u-2' }),
      );
    });

    it('memberNo 命中但 member 已软删 → 视作未命中:不反查 user,dummy compare + LOGIN_FAILED', async () => {
      const prisma = makePrismaMock();
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.member.findUnique.mockResolvedValue({
        id: 'mem-1',
        deletedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      const service = makeService(prisma);

      await expect(service.login(makeLoginDto({ username: 'SR-001' }), META)).rejects.toEqual(
        new BizException(BizCode.LOGIN_FAILED),
      );

      // 软删 member 不触发 memberId 反查(findFirst 仅 username 路径调了 1 次)
      expect(prisma.user.findFirst).toHaveBeenCalledTimes(1);
      expect(bcryptMock.compare).toHaveBeenCalledTimes(1);
      expect(bcryptMock.compare).toHaveBeenCalledWith(
        'Secret123',
        expect.stringMatching(/^\$2a\$10\$/),
      );
    });
  });

  // ============ 2. createSession — 会话签发契约(login / login-sms 唯一共用路径) ============
  describe('createSession — 会话签发契约', () => {
    it('JWT payload 严格 { sub, username } 恰 2 字段;role 不进 payload', async () => {
      const prisma = makePrismaMock();
      const jwt = makeJwtMock();
      const service = makeService(prisma, { jwt });

      await service.createSession(
        { id: 'u-1', username: 'alice', role: Role.ADMIN },
        META,
        'auth.login',
      );

      expect(jwt.signAsync).toHaveBeenCalledTimes(1);
      const payload = jwt.signAsync.mock.calls[0][0] as Record<string, unknown>;
      expect(payload).toEqual({ sub: 'u-1', username: 'alice' });
      // 无多字段(JwtPayload 最小化封板;role / tokenVersion / 完整用户对象均禁止)
      expect(Object.keys(payload).sort()).toEqual(['sub', 'username']);
    });

    it('refresh 入库只存 sha256 hash(明文不入库);family 随机创建;expiresAt = now + JWT_REFRESH_EXPIRES_IN', async () => {
      const prisma = makePrismaMock();
      const service = makeService(prisma);

      const before = Date.now();
      const res = await service.createSession(
        { id: 'u-1', username: 'alice', role: Role.USER },
        META,
        'auth.login',
      );
      const after = Date.now();

      expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
      const createArg = prisma.refreshToken.create.mock.calls[0][0] as {
        data: {
          userId: string;
          tokenHash: string;
          familyId: string;
          expiresAt: Date;
          ipFirstSeen: string | null;
          uaFirstSeen: string | null;
        };
      };
      expect(createArg.data.userId).toBe('u-1');
      // 入库的是响应明文的 sha256(64 hex);明文(43 字符 base64url)不以任何形态入库
      expect(createArg.data.tokenHash).toBe(hashRefreshToken(res.refreshToken));
      expect(createArg.data.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(res.refreshToken).toHaveLength(43);
      expect(JSON.stringify(createArg.data)).not.toContain(res.refreshToken);
      // family 创建(32 hex 随机 id)
      expect(createArg.data.familyId).toMatch(/^[0-9a-f]{32}$/);
      // login 时的 IP / UA 快照
      expect(createArg.data.ipFirstSeen).toBe(META.ip);
      expect(createArg.data.uaFirstSeen).toBe(META.ua);
      // absolute expiration:now + 90d(夹逼);响应 refreshExpiresAt 与入库 expiresAt 同一时刻
      const expMs = createArg.data.expiresAt.getTime();
      expect(expMs).toBeGreaterThanOrEqual(before + TTL_90D_MS);
      expect(expMs).toBeLessThanOrEqual(after + TTL_90D_MS);
      expect(res.refreshExpiresAt).toBe(createArg.data.expiresAt.toISOString());
    });

    it('事务接线:create + audit 同 tx;event 由调用方传入;extraAudit 合并进 extra 且不含明文/hash', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      const service = makeService(prisma, { auditLogs });

      const res = await service.createSession(
        { id: 'u-1', username: 'alice', role: Role.USER },
        META,
        'auth.login.sms',
        { phone: '138****1234', codeId: 'code-1' },
      );

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const createArg = prisma.refreshToken.create.mock.calls[0][0] as {
        data: { familyId: string; tokenHash: string };
      };
      expect(auditLogs.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'auth.login.sms',
          actorUserId: 'u-1',
          actorRoleSnap: Role.USER,
          resourceType: 'user',
          resourceId: 'u-1',
          meta: META,
          tx: prisma,
        }),
      );
      const logArg = auditLogs.log.mock.calls[0][0] as { extra: Record<string, unknown> };
      expect(logArg.extra).toEqual({
        familyId: createArg.data.familyId,
        phone: '138****1234',
        codeId: 'code-1',
      });
      // extra 禁明文 / hash 任何形态
      expect(JSON.stringify(logArg.extra)).not.toContain(res.refreshToken);
      expect(JSON.stringify(logArg.extra)).not.toContain(createArg.data.tokenHash);
    });

    it('lastLoginAt fire-and-forget:成功路径事务外 update { lastLoginAt }', async () => {
      const prisma = makePrismaMock();
      const service = makeService(prisma);

      await service.createSession(
        { id: 'u-1', username: 'alice', role: Role.USER },
        META,
        'auth.login',
      );

      expect(prisma.user.update).toHaveBeenCalledTimes(1);
      const updateArg = prisma.user.update.mock.calls[0][0] as {
        where: { id: string };
        data: { lastLoginAt: Date };
      };
      expect(updateArg.where).toEqual({ id: 'u-1' });
      expect(updateArg.data.lastLoginAt).toBeInstanceOf(Date);
    });

    it('lastLoginAt 更新失败不阻断响应:update reject → createSession 仍 resolve,只 logger.warn', async () => {
      const prisma = makePrismaMock();
      prisma.user.update.mockRejectedValue(new Error('db down'));
      const service = makeService(prisma);

      const res = await service.createSession(
        { id: 'u-1', username: 'alice', role: Role.USER },
        META,
        'auth.login',
      );

      expect(res.accessToken).toBe('signed.access.jwt');
      // flush fire-and-forget 的 .catch 微任务后,只产生 warn,不向外抛
      await new Promise((resolve) => setImmediate(resolve));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('u-1'));
    });

    it('jwt.config 未加载 → 抛防御性 Error;不产生任何写', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      const config = {
        get: jest.fn<JwtConfig | undefined, [string]>().mockReturnValue(undefined),
      };
      const service = makeService(prisma, { auditLogs, config });

      await expect(
        service.createSession(
          { id: 'u-1', username: 'alice', role: Role.USER },
          META,
          'auth.login',
        ),
      ).rejects.toThrow('jwt.config 未加载');

      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      expect(auditLogs.log).not.toHaveBeenCalled();
    });
  });

  // ============ 3. refresh — rotation / reuse 检测 / check-and-set 输家分支 ============
  describe('refresh — rotation / reuse 检测 / 输家分支', () => {
    it('成功 rotation:旧标 rotated+revoked → 新 token 同 family 继承 absolute expiresAt → replacedById 回填 → audit', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      const jwt = makeJwtMock();
      const row = makeRefreshRow();
      prisma.refreshToken.findUnique.mockResolvedValue(row);
      prisma.user.findFirst.mockResolvedValue(makeLoginUser());
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      prisma.refreshToken.create.mockResolvedValue({ id: 'rt-new' });
      const service = makeService(prisma, { auditLogs, jwt });

      const res = await service.refresh({ refreshToken: OLD_RAW }, META);

      // 按 sha256(明文) 查行(「hash 不符」≡ 查不到)
      expect(prisma.refreshToken.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tokenHash: OLD_HASH } }),
      );
      // check-and-set:仅 fresh 行可标 rotated(TOCTOU 防御);rotation 同时设 rotatedAt + revokedAt
      const casArg = prisma.refreshToken.updateMany.mock.calls[0][0] as {
        where: { id: string; rotatedAt: null; revokedAt: null };
        data: { rotatedAt: Date; revokedAt: Date; revokedReason: string };
      };
      expect(casArg.where).toEqual({ id: 'rt-1', rotatedAt: null, revokedAt: null });
      expect(casArg.data.rotatedAt).toBeInstanceOf(Date);
      expect(casArg.data.revokedAt).toBeInstanceOf(Date);
      expect(casArg.data.revokedReason).toBe('rotated');
      // 新行:family 继承 + absolute expiresAt 继承原行(不延长)+ 新明文 ↔ 新 hash
      const createArg = prisma.refreshToken.create.mock.calls[0][0] as {
        data: { userId: string; tokenHash: string; familyId: string; expiresAt: Date };
      };
      expect(createArg.data.userId).toBe('u-1');
      expect(createArg.data.familyId).toBe('fam-1');
      expect(createArg.data.expiresAt).toEqual(row.expiresAt);
      expect(createArg.data.tokenHash).toBe(hashRefreshToken(res.refreshToken));
      expect(res.refreshToken).not.toBe(OLD_RAW);
      expect(res.refreshToken).toHaveLength(43);
      // 旧行回填 replacedById(rotation 链可追溯)
      expect(prisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: 'rt-1' },
        data: { replacedById: 'rt-new' },
      });
      // 新 access payload 严格 { sub, username }
      expect(jwt.signAsync).toHaveBeenCalledWith({ sub: 'u-1', username: 'alice' });
      // rotation 全链在单一事务内;audit auth.refresh(extra 锁形:无 familyRevoked 字段)
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(auditLogs.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'auth.refresh',
          actorUserId: 'u-1',
          actorRoleSnap: Role.USER,
          resourceType: 'refresh_token',
          resourceId: 'rt-1',
          meta: META,
          tx: prisma,
        }),
      );
      const logArg = auditLogs.log.mock.calls[0][0] as { extra: Record<string, unknown> };
      expect(logArg.extra).toEqual({ familyId: 'fam-1', replayDetected: false });
      // 返回新 pair:refreshExpiresAt = 原 family absolute 时刻
      expect(res.accessToken).toBe('signed.access.jwt');
      expect(res.tokenType).toBe('Bearer');
      expect(res.expiresIn).toBe('15m');
      expect(res.refreshExpiresAt).toBe(row.expiresAt.toISOString());
    });

    it('reuse 检测:rotatedAt≠null(重放)→ family revoke + audit{replayDetected,familyRevoked} + REFRESH_TOKEN_INVALID;rotatedAt 判定优先于 revokedAt', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      const jwt = makeJwtMock();
      // rotation 路径会同时设 rotatedAt + revokedAt + reason='rotated' —— 重放行的真实形态;
      // 两者同时非 null 时必须走 reuse 分支(family revoke),不得被「已撤销」分支静默吞掉。
      const row = makeRefreshRow({
        rotatedAt: minutesFromNow(-5),
        revokedAt: minutesFromNow(-5),
      });
      prisma.refreshToken.findUnique.mockResolvedValue(row);
      const service = makeService(prisma, { auditLogs, jwt });

      await expect(service.refresh({ refreshToken: OLD_RAW }, META)).rejects.toEqual(
        new BizException(BizCode.REFRESH_TOKEN_INVALID),
      );

      // family revoke:撤整个 family 所有未撤销行
      const revokeArg = prisma.refreshToken.updateMany.mock.calls[0][0] as {
        where: { familyId: string; revokedAt: null };
        data: { revokedAt: Date; revokedReason: string };
      };
      expect(revokeArg.where).toEqual({ familyId: 'fam-1', revokedAt: null });
      expect(revokeArg.data.revokedAt).toBeInstanceOf(Date);
      expect(revokeArg.data.revokedReason).toBe('family-revoked');
      expect(auditLogs.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'auth.refresh',
          actorUserId: 'u-1',
          actorRoleSnap: null,
          resourceType: 'refresh_token',
          resourceId: 'rt-1',
          tx: prisma,
        }),
      );
      const logArg = auditLogs.log.mock.calls[0][0] as { extra: Record<string, unknown> };
      expect(logArg.extra).toEqual({
        familyId: 'fam-1',
        replayDetected: true,
        familyRevoked: true,
      });
      // 不发新 token / 不签 access / 不查 user(rotatedAt 检查先于 user 检查)
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      expect(jwt.signAsync).not.toHaveBeenCalled();
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    });

    it('check-and-set 输家分支:updateMany count=0(并发 race)→ REFRESH_TOKEN_INVALID;不 create / 不审计 / 不 family revoke', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      const jwt = makeJwtMock();
      prisma.refreshToken.findUnique.mockResolvedValue(makeRefreshRow());
      prisma.user.findFirst.mockResolvedValue(makeLoginUser());
      // 读时 fresh,事务内 check-and-set 已被并发对手抢先 → count=0
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });
      const service = makeService(prisma, { auditLogs, jwt });

      await expect(service.refresh({ refreshToken: OLD_RAW }, META)).rejects.toEqual(
        new BizException(BizCode.REFRESH_TOKEN_INVALID),
      );

      // updateMany 只发生 1 次且是 check-and-set 自身(不是攻击 → 无 family revoke)
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'rt-1', rotatedAt: null, revokedAt: null } }),
      );
      // 输家不发新 token / 不回填 replacedById / 不签 access / 不审计
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      expect(prisma.refreshToken.update).not.toHaveBeenCalled();
      expect(jwt.signAsync).not.toHaveBeenCalled();
      expect(auditLogs.log).not.toHaveBeenCalled();
    });

    it('查不到(token 不存在 / hash 不符)→ REFRESH_TOKEN_INVALID;不写 audit、不开事务', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.refreshToken.findUnique.mockResolvedValue(null);
      const service = makeService(prisma, { auditLogs });

      await expect(service.refresh({ refreshToken: 'unknown-raw' }, META)).rejects.toEqual(
        new BizException(BizCode.REFRESH_TOKEN_INVALID),
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
      expect(auditLogs.log).not.toHaveBeenCalled();
    });

    it('过期 family → REFRESH_TOKEN_INVALID;过期判定先于重放判定(过期 + rotatedAt≠null 也不触发 family revoke)', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.refreshToken.findUnique.mockResolvedValue(
        makeRefreshRow({
          expiresAt: minutesFromNow(-1),
          rotatedAt: minutesFromNow(-5),
          revokedAt: minutesFromNow(-5),
        }),
      );
      const service = makeService(prisma, { auditLogs });

      await expect(service.refresh({ refreshToken: OLD_RAW }, META)).rejects.toEqual(
        new BizException(BizCode.REFRESH_TOKEN_INVALID),
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
      expect(auditLogs.log).not.toHaveBeenCalled();
    });

    it('已撤销但非 rotation(logout / admin 撤销;rotatedAt=null)→ REFRESH_TOKEN_INVALID;不 family revoke、不写 audit', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.refreshToken.findUnique.mockResolvedValue(
        makeRefreshRow({ revokedAt: minutesFromNow(-5), rotatedAt: null }),
      );
      const service = makeService(prisma, { auditLogs });

      await expect(service.refresh({ refreshToken: OLD_RAW }, META)).rejects.toEqual(
        new BizException(BizCode.REFRESH_TOKEN_INVALID),
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
      expect(auditLogs.log).not.toHaveBeenCalled();
    });

    it('user 已禁用 → family revoke + audit{replayDetected:false,familyRevoked:true} + REFRESH_TOKEN_INVALID', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      const jwt = makeJwtMock();
      prisma.refreshToken.findUnique.mockResolvedValue(makeRefreshRow());
      prisma.user.findFirst.mockResolvedValue(makeLoginUser({ status: UserStatus.DISABLED }));
      const service = makeService(prisma, { auditLogs, jwt });

      await expect(service.refresh({ refreshToken: OLD_RAW }, META)).rejects.toEqual(
        new BizException(BizCode.REFRESH_TOKEN_INVALID),
      );

      const revokeArg = prisma.refreshToken.updateMany.mock.calls[0][0] as {
        where: { familyId: string; revokedAt: null };
        data: { revokedAt: Date; revokedReason: string };
      };
      expect(revokeArg.where).toEqual({ familyId: 'fam-1', revokedAt: null });
      expect(revokeArg.data.revokedAt).toBeInstanceOf(Date);
      expect(revokeArg.data.revokedReason).toBe('family-revoked');
      const logArg = auditLogs.log.mock.calls[0][0] as { extra: Record<string, unknown> };
      expect(logArg.extra).toEqual({
        familyId: 'fam-1',
        replayDetected: false,
        familyRevoked: true,
      });
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });

    it('user 软删 / 不存在(查询锁 deletedAt:null)→ family revoke + REFRESH_TOKEN_INVALID', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.refreshToken.findUnique.mockResolvedValue(makeRefreshRow());
      prisma.user.findFirst.mockResolvedValue(null);
      const service = makeService(prisma, { auditLogs });

      await expect(service.refresh({ refreshToken: OLD_RAW }, META)).rejects.toEqual(
        new BizException(BizCode.REFRESH_TOKEN_INVALID),
      );

      // user 有效性检查的查询条件锁形(软删在查询层过滤)
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { id: 'u-1', deletedAt: null },
        select: { id: true, username: true, role: true, status: true },
      });
      const revokeArg = prisma.refreshToken.updateMany.mock.calls[0][0] as {
        where: { familyId: string; revokedAt: null };
        data: { revokedAt: Date; revokedReason: string };
      };
      expect(revokeArg.where).toEqual({ familyId: 'fam-1', revokedAt: null });
      expect(revokeArg.data.revokedAt).toBeInstanceOf(Date);
      expect(revokeArg.data.revokedReason).toBe('family-revoked');
      const logArg = auditLogs.log.mock.calls[0][0] as { extra: Record<string, unknown> };
      expect(logArg.extra).toEqual({
        familyId: 'fam-1',
        replayDetected: false,
        familyRevoked: true,
      });
    });
  });

  // ============ 4. logout — 幂等撤销 refresh family ============
  describe('logout — 幂等撤销 refresh family', () => {
    it('fresh leaf → updateMany 撤销同 family 活跃未过期行;真实变化写 family audit;返 null', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.refreshToken.findUnique.mockResolvedValue(makeRefreshRow());
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 2 });
      const service = makeService(prisma, { auditLogs });

      const res = await service.logout({ refreshToken: OLD_RAW }, META);

      expect(res).toBeNull();
      expect(prisma.refreshToken.findUnique).toHaveBeenCalledWith({
        where: { tokenHash: OLD_HASH },
        select: { id: true, userId: true, familyId: true, expiresAt: true },
      });
      const revokeArg = prisma.refreshToken.updateMany.mock.calls[0][0] as {
        where: { familyId: string; revokedAt: null; expiresAt: { gt: Date } };
        data: { revokedAt: Date; revokedReason: string };
      };
      expect(revokeArg.where.familyId).toBe('fam-1');
      expect(revokeArg.where.revokedAt).toBeNull();
      expect(revokeArg.where.expiresAt.gt).toBeInstanceOf(Date);
      expect(revokeArg.data.revokedAt).toBe(revokeArg.where.expiresAt.gt);
      expect(revokeArg.data.revokedReason).toBe('logout');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(auditLogs.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'auth.logout',
          actorUserId: 'u-1',
          actorRoleSnap: null,
          resourceType: 'refresh_token',
          resourceId: 'rt-1',
          meta: META,
          tx: prisma,
        }),
      );
      const logArg = auditLogs.log.mock.calls[0][0] as { extra: Record<string, unknown> };
      expect(logArg.extra).toEqual({ familyId: 'fam-1', revokedCount: 2 });
    });

    it('rotated ancestor 仍定位 family 并显式撤销,不进入 refresh reuse detection', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.refreshToken.findUnique.mockResolvedValue(
        makeRefreshRow({ rotatedAt: minutesFromNow(-5), revokedAt: minutesFromNow(-5) }),
      );
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      const service = makeService(prisma, { auditLogs });

      const res = await service.logout({ refreshToken: OLD_RAW }, META);

      expect(res).toBeNull();
      const revokeArg = prisma.refreshToken.updateMany.mock.calls[0][0] as {
        where: { familyId: string; revokedAt: null; expiresAt: { gt: Date } };
        data: { revokedAt: Date; revokedReason: string };
      };
      expect(revokeArg.where.familyId).toBe('fam-1');
      expect(revokeArg.where.revokedAt).toBeNull();
      expect(revokeArg.data.revokedReason).toBe('logout');
      expect(auditLogs.log).toHaveBeenCalledTimes(1);
      expect(auditLogs.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'auth.logout',
          extra: { familyId: 'fam-1', revokedCount: 1 },
        }),
      );
    });

    it('token 不存在 → 不抛仍返 null;不 updateMany;不写 audit', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.refreshToken.findUnique.mockResolvedValue(null);
      const service = makeService(prisma, { auditLogs });

      const res = await service.logout({ refreshToken: 'unknown-raw' }, META);

      expect(res).toBeNull();
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
      expect(auditLogs.log).not.toHaveBeenCalled();
    });

    it('family 已全撤(updateMany count=0)→ 幂等返 null;不写 audit', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.refreshToken.findUnique.mockResolvedValue(
        makeRefreshRow({ revokedAt: minutesFromNow(-5) }),
      );
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });
      const service = makeService(prisma, { auditLogs });

      const res = await service.logout({ refreshToken: OLD_RAW }, META);

      expect(res).toBeNull();
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledTimes(1);
      expect(auditLogs.log).not.toHaveBeenCalled();
    });

    it('row 已过期 → 不 updateMany 仍返 null;不写 audit', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.refreshToken.findUnique.mockResolvedValue(
        makeRefreshRow({ expiresAt: minutesFromNow(-1) }),
      );
      const service = makeService(prisma, { auditLogs });

      const res = await service.logout({ refreshToken: OLD_RAW }, META);

      expect(res).toBeNull();
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
      expect(auditLogs.log).not.toHaveBeenCalled();
    });
  });

  // ============ 5. logoutAll — 撤销全部未过期未撤销 ============
  describe('logoutAll — 撤销全部', () => {
    it('updateMany 撤该 user 全部未过期且未撤销的行 → 返 { revokedCount };audit auth.logout-all', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 3 });
      const service = makeService(prisma, { auditLogs });

      const res = await service.logoutAll(makeCurrentUser(), META);

      expect(res).toEqual({ revokedCount: 3 });
      const umArg = prisma.refreshToken.updateMany.mock.calls[0][0] as {
        where: { userId: string; revokedAt: null; expiresAt: { gt: Date } };
        data: { revokedAt: Date; revokedReason: string };
      };
      expect(umArg.where.userId).toBe('admin-1');
      expect(umArg.where.revokedAt).toBeNull();
      expect(umArg.where.expiresAt.gt).toBeInstanceOf(Date);
      expect(umArg.data.revokedAt).toBeInstanceOf(Date);
      expect(umArg.data.revokedReason).toBe('logout');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(auditLogs.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'auth.logout-all',
          actorUserId: 'admin-1',
          actorRoleSnap: Role.ADMIN,
          resourceType: 'user',
          resourceId: 'admin-1',
          meta: META,
          tx: prisma,
        }),
      );
      const logArg = auditLogs.log.mock.calls[0][0] as { extra: Record<string, unknown> };
      expect(logArg.extra).toEqual({ revokedCount: 3 });
    });

    it('幂等:0 行可撤 → 仍写 audit(extra.revokedCount=0)并返 { revokedCount: 0 }', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });
      const service = makeService(prisma, { auditLogs });

      const res = await service.logoutAll(makeCurrentUser({ id: 'u-9', role: Role.USER }), META);

      expect(res).toEqual({ revokedCount: 0 });
      const logArg = auditLogs.log.mock.calls[0][0] as { extra: Record<string, unknown> };
      expect(logArg.extra).toEqual({ revokedCount: 0 });
      expect(auditLogs.log).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'auth.logout-all', actorUserId: 'u-9' }),
      );
    });
  });
});
