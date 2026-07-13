import { Prisma, Role, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { LastAdminProtectionPolicy } from '../permissions/last-admin-protection.policy';
import type { RbacService } from '../permissions/rbac.service';
import type { SmsCodeService } from '../sms/sms-code.service';
import type { WechatService } from '../wechat/wechat.service';
import type {
  CreateUserDto,
  ResetUserPasswordDto,
  UpdateMyProfileDto,
  UpdateUserDto,
  UpdateUserRoleDto,
  UpdateUserStatusDto,
} from './users.dto';
import { UsersService } from './users.service';

jest.mock('bcryptjs');

// users service-level characterization spec(B 档 test-only,scoped;沿 srvf-god-service-refactor）。
// 锁定 `users.service.ts`(544L,large-service watch)内部「编排契约」现状行为,作为后续
// Presenter / QueryService 抽离前的快速重构护栏。本服务安全敏感(改密时序 / 最后 SUPER_ADMIN /
// 自我保护 / refresh token 联动撤销),本 spec 只**锁定现状**,不改任何业务行为 / BizCode / audit event 名。
//
// 风格沿 src/modules/certificates/certificates.service.spec.ts
//      + src/modules/activities/activities.service.spec.ts:
// - 纯构造器注入 mock(prisma / auditLogs / rbac),不使用 NestJS TestingModule、不连库、不起 Nest。
// - `$transaction` 双模:callback(改密 / 重置 / 改角色 / 改状态 / 软删)+ array(list 分页)。
// - `bcryptjs` 是模块级 import(非注入),用 `jest.mock` 桩 hash / compare,使时序断言确定且秒级。
//
// 边界(本 spec 只到 service 编排层):
// - **不**复刻 `users.policy.ts` 角色矩阵(纯函数已由 `users.policy.spec.ts` 覆盖;此处用真实角色值触达分支)。
// - **不**断言 `auditLogs.log` 内部快照结构;只断言被调用 + event 名 + tx + extra.refreshTokensRevoked 接线。
// - **不**测 bcrypt 真实哈希强度(桩返回值),只锁「compare 在 same-as-old 校验**之前**跑完」等时序契约。
// - **不**测 `app-capability.service.ts` / `app-profile.service.ts`(App 视角独立类,非本 service)。
// - **不**测 HTTP / Guard / Prisma 集成 / 完整 e2e。

const bcryptMock = jest.mocked(bcrypt);

// ============ 固定 fixture ============

const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');
const META: AuditMeta = { requestId: 'req-user-1', ip: '127.0.0.1', ua: 'jest' };

// ============ 行形 ============

// userSafeSelect 10 字段(永不含 passwordHash / deletedAt)。
interface SafeUserRow {
  id: string;
  username: string;
  email: string | null;
  nickname: string | null;
  avatarKey: string | null;
  role: Role;
  status: UserStatus;
  createdAt: Date;
  lastLoginAt: Date | null;
  updatedAt: Date;
}

function makeSafeUser(overrides: Partial<SafeUserRow> = {}): SafeUserRow {
  return {
    id: 'u-1',
    username: 'alice',
    email: 'alice@example.com',
    nickname: null,
    avatarKey: null,
    role: Role.USER,
    status: UserStatus.ACTIVE,
    createdAt: FIXED_DATE,
    lastLoginAt: null,
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

// findRawByIdOrThrow 的精简 select(id/role/status)。
type RawUserRow = { id: string; role: Role; status: UserStatus };
// changeMyPassword 的 passwordHash select。
type PwUserRow = { id: string; passwordHash: string };

function makeCurrentUser(overrides: Partial<CurrentUserPayload> = {}): CurrentUserPayload {
  return {
    id: 'admin-1',
    username: 'admin',
    role: Role.SUPER_ADMIN,
    status: UserStatus.ACTIVE,
    memberId: null,
    ...overrides,
  };
}

// ============ DTO 工厂 ============

function makeCreateDto(overrides: Partial<Record<string, unknown>> = {}): CreateUserDto {
  return { username: 'NewUser', password: 'Passw0rd1', ...overrides };
}
function makeUpdateDto(overrides: Partial<Record<string, unknown>> = {}): UpdateUserDto {
  return { ...overrides };
}
function makeProfileDto(overrides: Partial<Record<string, unknown>> = {}): UpdateMyProfileDto {
  return { ...overrides };
}
function makeResetPwDto(newPassword = 'NewPassw0rd1'): ResetUserPasswordDto {
  return { newPassword };
}
function makeRoleDto(role: Role): UpdateUserRoleDto {
  return { role };
}
function makeStatusDto(status: UserStatus): UpdateUserStatusDto {
  return { status };
}

// ============ mock 工厂 ============

function makePrismaMock() {
  const user = {
    findFirst: jest.fn<Promise<SafeUserRow | RawUserRow | PwUserRow | null>, [unknown]>(),
    findUnique: jest.fn<Promise<{ id: string } | null>, [unknown]>(),
    findMany: jest.fn<Promise<SafeUserRow[]>, [unknown]>(),
    count: jest.fn<Promise<number>, [unknown]>(),
    create: jest.fn<Promise<SafeUserRow>, [unknown]>(),
    update: jest.fn<Promise<SafeUserRow>, [unknown]>(),
  };
  const refreshToken = {
    updateMany: jest.fn<Promise<{ count: number }>, [unknown]>().mockResolvedValue({ count: 0 }),
  };
  const $transaction = jest.fn<Promise<unknown>, [unknown]>();
  const prisma = { user, refreshToken, $transaction };
  // 双模:回调式把 prisma mock 自身当 tx 传入;数组式($transaction([findMany, count]))走 Promise.all。
  $transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: typeof prisma) => Promise<unknown>)(prisma)
      : Promise.all(arg as Array<Promise<unknown>>),
  );
  return prisma;
}
type PrismaMock = ReturnType<typeof makePrismaMock>;

function makeAuditLogsMock() {
  return { log: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined) };
}
type AuditLogsMock = ReturnType<typeof makeAuditLogsMock>;

// SMS T3:UsersService 构造器新增 SmsCodeService 依赖;既有 characterization 用例
// 不触达 phone 方法,mock 仅满足构造器形参(沿 auditLogs mock 范式)。
function makeSmsCodeMock() {
  return {
    issue: jest.fn<Promise<{ expiresInSeconds: number }>, [unknown]>(),
    verifyAndConsume: jest.fn<Promise<{ codeId: string }>, [unknown]>(),
  };
}
type SmsCodeMock = ReturnType<typeof makeSmsCodeMock>;

// rbac.can 默认放行;deny 用例显式 mockResolvedValue(false)。
function makeRbacMock(allow = true) {
  return { can: jest.fn<Promise<boolean>, [unknown, unknown]>().mockResolvedValue(allow) };
}
type RbacMock = ReturnType<typeof makeRbacMock>;

function makeLastAdminProtectionMock() {
  return {
    assertCanRemoveSuperAdmin: jest.fn<Promise<void>, [unknown, string]>().mockResolvedValue(),
    assertCanRemoveOpsAdminBinding: jest
      .fn<Promise<void>, [unknown, unknown]>()
      .mockResolvedValue(),
    assertCanDeactivateOpsAdminUser: jest
      .fn<Promise<void>, [unknown, string]>()
      .mockResolvedValue(),
  };
}
type LastAdminProtectionMock = ReturnType<typeof makeLastAdminProtectionMock>;

// 微信 T3:UsersService 构造器新增 WechatService 依赖;既有 characterization 用例
// 不触达 wechat 方法,mock 仅满足构造器形参(沿 smsCode mock 范式)。
function makeWechatMock() {
  return {
    code2session: jest.fn<Promise<{ openid: string }>, [string]>(),
  };
}
type WechatMock = ReturnType<typeof makeWechatMock>;

function makeService(
  prisma: PrismaMock,
  opts: {
    auditLogs?: AuditLogsMock;
    rbac?: RbacMock;
    lastAdminProtection?: LastAdminProtectionMock;
    smsCode?: SmsCodeMock;
    wechat?: WechatMock;
  } = {},
): UsersService {
  const auditLogs = opts.auditLogs ?? makeAuditLogsMock();
  const rbac = opts.rbac ?? makeRbacMock();
  const lastAdminProtection = opts.lastAdminProtection ?? makeLastAdminProtectionMock();
  const smsCode = opts.smsCode ?? makeSmsCodeMock();
  const wechat = opts.wechat ?? makeWechatMock();
  return new UsersService(
    prisma as unknown as PrismaService,
    auditLogs as unknown as AuditLogsService,
    rbac as unknown as RbacService,
    lastAdminProtection as unknown as LastAdminProtectionPolicy,
    smsCode as unknown as SmsCodeService,
    wechat as unknown as WechatService,
  );
}

describe('UsersService (characterization, scoped)', () => {
  beforeEach(() => {
    bcryptMock.hash.mockResolvedValue('hashed-new' as never);
    bcryptMock.compare.mockResolvedValue(true as never);
  });
  afterEach(() => {
    jest.clearAllMocks();
  });

  // ============ 1. /me read & profile(无 rbac)============
  describe('/me — findMe / updateMyProfile', () => {
    it('findMe → findFirst(notDeleted) 返回 safe user', async () => {
      const prisma = makePrismaMock();
      prisma.user.findFirst.mockResolvedValue(makeSafeUser({ id: 'me-1', username: 'me' }));
      const service = makeService(prisma);

      const res = await service.findMe(makeCurrentUser({ id: 'me-1' }));

      expect(res.id).toBe('me-1');
      expect(res.username).toBe('me');
      const arg = prisma.user.findFirst.mock.calls[0][0] as {
        where: { id: string; deletedAt: null };
      };
      expect(arg.where.id).toBe('me-1');
      expect(arg.where.deletedAt).toBeNull();
    });

    it('findMe:本人记录已软删 → USER_NOT_FOUND', async () => {
      const prisma = makePrismaMock();
      prisma.user.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(service.findMe(makeCurrentUser({ id: 'me-1' }))).rejects.toEqual(
        new BizException(BizCode.USER_NOT_FOUND),
      );
    });

    it('updateMyProfile → 仅写 nickname / avatarKey;返回 safe user', async () => {
      const prisma = makePrismaMock();
      prisma.user.findFirst.mockResolvedValue(makeSafeUser({ id: 'me-1' }));
      prisma.user.update.mockResolvedValue(makeSafeUser({ id: 'me-1', nickname: 'Ali' }));
      const service = makeService(prisma);

      const res = await service.updateMyProfile(
        makeCurrentUser({ id: 'me-1' }),
        makeProfileDto({ nickname: 'Ali', avatarKey: 'a.png' }),
      );

      const updateArg = prisma.user.update.mock.calls[0][0] as {
        where: { id: string };
        data: { nickname?: string; avatarKey?: string };
      };
      expect(updateArg.where.id).toBe('me-1');
      expect(updateArg.data.nickname).toBe('Ali');
      expect(updateArg.data.avatarKey).toBe('a.png');
      expect(res.nickname).toBe('Ali');
    });

    it('updateMyProfile:本人记录已软删(race)→ USER_NOT_FOUND;不 update', async () => {
      const prisma = makePrismaMock();
      prisma.user.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(
        service.updateMyProfile(makeCurrentUser({ id: 'me-1' }), makeProfileDto({ nickname: 'x' })),
      ).rejects.toEqual(new BizException(BizCode.USER_NOT_FOUND));
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  // ============ 2. changeMyPassword — 安全时序 + 联动撤销 + audit ============
  describe('changeMyPassword — ordering / revoke / audit', () => {
    it('本人记录不存在 → USER_NOT_FOUND;不比对 bcrypt', async () => {
      const prisma = makePrismaMock();
      prisma.user.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(
        service.changeMyPassword(
          makeCurrentUser({ id: 'me-1' }),
          { oldPassword: 'a', newPassword: 'b' },
          META,
        ),
      ).rejects.toEqual(new BizException(BizCode.USER_NOT_FOUND));
      expect(bcryptMock.compare).not.toHaveBeenCalled();
    });

    it('oldPassword 错(compare=false)→ OLD_PASSWORD_INVALID;不 update / 不撤销 / 不审计', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.user.findFirst.mockResolvedValue({ id: 'me-1', passwordHash: 'stored-hash' });
      bcryptMock.compare.mockResolvedValue(false as never);
      const service = makeService(prisma, { auditLogs });

      await expect(
        service.changeMyPassword(
          makeCurrentUser({ id: 'me-1' }),
          { oldPassword: 'wrong', newPassword: 'NewPassw0rd1' },
          META,
        ),
      ).rejects.toEqual(new BizException(BizCode.OLD_PASSWORD_INVALID));
      expect(bcryptMock.compare).toHaveBeenCalledWith('wrong', 'stored-hash');
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
      expect(auditLogs.log).not.toHaveBeenCalled();
    });

    it('new === old(但 compare 通过)→ NEW_PASSWORD_SAME_AS_OLD;**compare 仍先跑**(timing-oracle 防御)', async () => {
      const prisma = makePrismaMock();
      prisma.user.findFirst.mockResolvedValue({ id: 'me-1', passwordHash: 'stored-hash' });
      const service = makeService(prisma);

      await expect(
        service.changeMyPassword(
          makeCurrentUser({ id: 'me-1' }),
          { oldPassword: 'Same0ne!', newPassword: 'Same0ne!' },
          META,
        ),
      ).rejects.toEqual(new BizException(BizCode.NEW_PASSWORD_SAME_AS_OLD));
      // 锁定时序:bcrypt.compare 在 same-as-old 校验之前已执行(评审稿 §5.5)。
      expect(bcryptMock.compare).toHaveBeenCalledWith('Same0ne!', 'stored-hash');
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('成功 → hash 写库 + 撤销本人 refresh(self-password-change)+ audit(extra.refreshTokensRevoked)', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.user.findFirst.mockResolvedValue({ id: 'me-1', passwordHash: 'stored-hash' });
      prisma.user.update.mockResolvedValue(makeSafeUser({ id: 'me-1' }));
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 3 });
      const service = makeService(prisma, { auditLogs });

      const res = await service.changeMyPassword(
        makeCurrentUser({ id: 'me-1', role: Role.USER }),
        { oldPassword: 'Old0ne!', newPassword: 'NewPassw0rd1' },
        META,
      );

      const updateArg = prisma.user.update.mock.calls[0][0] as { data: { passwordHash: string } };
      expect(updateArg.data.passwordHash).toBe('hashed-new');
      const revokeArg = prisma.refreshToken.updateMany.mock.calls[0][0] as {
        where: { userId: string; revokedAt: null };
        data: { revokedReason: string };
      };
      expect(revokeArg.where.userId).toBe('me-1');
      expect(revokeArg.data.revokedReason).toBe('self-password-change');
      expect(auditLogs.log).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'password.change.self', resourceId: 'me-1', tx: prisma }),
      );
      const logArg = auditLogs.log.mock.calls[0][0] as { extra: { refreshTokensRevoked: number } };
      expect(logArg.extra.refreshTokensRevoked).toBe(3);
      expect(res.id).toBe('me-1');
    });
  });

  // ============ 3. admin list — rbac + 可见角色 scope ============
  describe('list — rbac & visible-role scope', () => {
    it('rbac deny → RBAC_FORBIDDEN;不查库', async () => {
      const prisma = makePrismaMock();
      const rbac = makeRbacMock(false);
      const service = makeService(prisma, { rbac });

      await expect(service.list(makeCurrentUser(), { page: 1, pageSize: 20 })).rejects.toEqual(
        new BizException(BizCode.RBAC_FORBIDDEN),
      );
      expect(rbac.can).toHaveBeenCalledWith(expect.anything(), 'user.read.account');
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('ADMIN → where.role.in = [USER];分页 skip/take', async () => {
      const prisma = makePrismaMock();
      prisma.user.findMany.mockResolvedValue([makeSafeUser()]);
      prisma.user.count.mockResolvedValue(1);
      const service = makeService(prisma);

      const page = await service.list(makeCurrentUser({ role: Role.ADMIN }), {
        page: 2,
        pageSize: 10,
      });

      const arg = prisma.user.findMany.mock.calls[0][0] as {
        where: { role: { in: Role[] }; deletedAt: null };
        skip: number;
        take: number;
      };
      expect(arg.where.role.in).toEqual([Role.USER]);
      expect(arg.where.deletedAt).toBeNull();
      expect(arg.skip).toBe(10);
      expect(arg.take).toBe(10);
      expect(page.total).toBe(1);
    });

    it('SUPER_ADMIN → where.role.in 含全部 3 角色', async () => {
      const prisma = makePrismaMock();
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);
      const service = makeService(prisma);

      await service.list(makeCurrentUser({ role: Role.SUPER_ADMIN }), { page: 1, pageSize: 20 });

      const arg = prisma.user.findMany.mock.calls[0][0] as { where: { role: { in: Role[] } } };
      expect(arg.where.role.in).toHaveLength(3);
      expect(arg.where.role.in).toEqual(
        expect.arrayContaining([Role.SUPER_ADMIN, Role.ADMIN, Role.USER]),
      );
    });
  });

  // ============ 4. admin create — rbac + canCreateRole + 唯一性 + 归一化 ============
  describe('create — rbac / canCreateRole / uniqueness / normalize', () => {
    it('rbac deny → RBAC_FORBIDDEN;不 create', async () => {
      const prisma = makePrismaMock();
      const rbac = makeRbacMock(false);
      const service = makeService(prisma, { rbac });

      await expect(service.create(makeCurrentUser(), makeCreateDto())).rejects.toEqual(
        new BizException(BizCode.RBAC_FORBIDDEN),
      );
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('ADMIN 建 ADMIN(canCreateRole deny)→ FORBIDDEN_ROLE_OPERATION;不 create', async () => {
      const prisma = makePrismaMock();
      const service = makeService(prisma);

      await expect(
        service.create(makeCurrentUser({ role: Role.ADMIN }), makeCreateDto({ role: Role.ADMIN })),
      ).rejects.toEqual(new BizException(BizCode.FORBIDDEN_ROLE_OPERATION));
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('username 预检命中 → USERNAME_ALREADY_EXISTS;不 create', async () => {
      const prisma = makePrismaMock();
      prisma.user.findUnique.mockResolvedValue({ id: 'existing' });
      const service = makeService(prisma);

      await expect(
        service.create(makeCurrentUser(), makeCreateDto({ username: 'Taken' })),
      ).rejects.toEqual(new BizException(BizCode.USERNAME_ALREADY_EXISTS));
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('成功 → username/email 归一化(trim+lowercase)、role 默认 USER、hash 写库', async () => {
      const prisma = makePrismaMock();
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(makeSafeUser({ id: 'new-1' }));
      const service = makeService(prisma);

      const res = await service.create(
        makeCurrentUser(),
        makeCreateDto({ username: '  Bob  ', email: '  BOB@Example.COM ' }),
      );

      const createArg = prisma.user.create.mock.calls[0][0] as {
        data: { username: string; email: string | null; role: Role; passwordHash: string };
      };
      expect(createArg.data.username).toBe('bob');
      expect(createArg.data.email).toBe('bob@example.com');
      expect(createArg.data.role).toBe(Role.USER);
      expect(createArg.data.passwordHash).toBe('hashed-new');
      expect(res.id).toBe('new-1');
    });
  });

  // ============ 5. admin findOne / update — rbac + view/manage ============
  describe('findOne / update — rbac & view/manage gates', () => {
    it('findOne rbac deny → RBAC_FORBIDDEN', async () => {
      const prisma = makePrismaMock();
      const rbac = makeRbacMock(false);
      const service = makeService(prisma, { rbac });

      await expect(service.findOne(makeCurrentUser(), 'u-2')).rejects.toEqual(
        new BizException(BizCode.RBAC_FORBIDDEN),
      );
    });

    it('findOne 不存在 → USER_NOT_FOUND', async () => {
      const prisma = makePrismaMock();
      prisma.user.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(service.findOne(makeCurrentUser(), 'missing')).rejects.toEqual(
        new BizException(BizCode.USER_NOT_FOUND),
      );
    });

    it('ADMIN 查看 SUPER_ADMIN(canViewUser deny)→ FORBIDDEN_ROLE_OPERATION', async () => {
      const prisma = makePrismaMock();
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-2',
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      });
      const service = makeService(prisma);

      await expect(service.findOne(makeCurrentUser({ role: Role.ADMIN }), 'u-2')).rejects.toEqual(
        new BizException(BizCode.FORBIDDEN_ROLE_OPERATION),
      );
    });

    it('findOne 成功 → 先 raw 校验后再 full select 返回', async () => {
      const prisma = makePrismaMock();
      prisma.user.findFirst
        .mockResolvedValueOnce({ id: 'u-2', role: Role.USER, status: UserStatus.ACTIVE })
        .mockResolvedValueOnce(makeSafeUser({ id: 'u-2', username: 'bob' }));
      const service = makeService(prisma);

      const res = await service.findOne(makeCurrentUser(), 'u-2');

      expect(res.id).toBe('u-2');
      expect(res.username).toBe('bob');
      expect(prisma.user.findFirst).toHaveBeenCalledTimes(2);
    });

    it('update:ADMIN 改 SUPER_ADMIN(canManageUser deny)→ FORBIDDEN_ROLE_OPERATION;不 update', async () => {
      const prisma = makePrismaMock();
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-2',
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      });
      const service = makeService(prisma);

      await expect(
        service.update(
          makeCurrentUser({ role: Role.ADMIN }),
          'u-2',
          makeUpdateDto({ nickname: 'x' }),
        ),
      ).rejects.toEqual(new BizException(BizCode.FORBIDDEN_ROLE_OPERATION));
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('update 成功 → 透传 nickname;email 归一化', async () => {
      const prisma = makePrismaMock();
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-2',
        role: Role.USER,
        status: UserStatus.ACTIVE,
      });
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.update.mockResolvedValue(makeSafeUser({ id: 'u-2', nickname: 'Bobby' }));
      const service = makeService(prisma);

      const res = await service.update(
        makeCurrentUser(),
        'u-2',
        makeUpdateDto({ nickname: 'Bobby', email: ' NEW@X.COM ' }),
      );

      const updateArg = prisma.user.update.mock.calls[0][0] as {
        data: { nickname?: string; email?: string | null };
      };
      expect(updateArg.data.nickname).toBe('Bobby');
      expect(updateArg.data.email).toBe('new@x.com');
      expect(res.nickname).toBe('Bobby');
    });
  });

  // ============ 6. admin resetPassword — rbac + manage + 联动撤销 + audit ============
  describe('resetPassword — revoke & audit wiring', () => {
    it('rbac deny → RBAC_FORBIDDEN', async () => {
      const prisma = makePrismaMock();
      const rbac = makeRbacMock(false);
      const service = makeService(prisma, { rbac });

      await expect(
        service.resetPassword(makeCurrentUser(), 'u-2', makeResetPwDto(), META),
      ).rejects.toEqual(new BizException(BizCode.RBAC_FORBIDDEN));
    });

    it('成功 → hash 写库 + 撤销目标 refresh(admin-password-reset)+ audit(password.reset.by-admin)', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-2',
        role: Role.USER,
        status: UserStatus.ACTIVE,
      });
      prisma.user.update.mockResolvedValue(makeSafeUser({ id: 'u-2' }));
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 2 });
      const service = makeService(prisma, { auditLogs });

      await service.resetPassword(makeCurrentUser(), 'u-2', makeResetPwDto(), META);

      const updateArg = prisma.user.update.mock.calls[0][0] as { data: { passwordHash: string } };
      expect(updateArg.data.passwordHash).toBe('hashed-new');
      const revokeArg = prisma.refreshToken.updateMany.mock.calls[0][0] as {
        where: { userId: string };
        data: { revokedReason: string };
      };
      expect(revokeArg.where.userId).toBe('u-2');
      expect(revokeArg.data.revokedReason).toBe('admin-password-reset');
      expect(auditLogs.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'password.reset.by-admin',
          resourceId: 'u-2',
          tx: prisma,
        }),
      );
      const logArg = auditLogs.log.mock.calls[0][0] as { extra: { refreshTokensRevoked: number } };
      expect(logArg.extra.refreshTokensRevoked).toBe(2);
    });
  });

  // ============ 7. admin updateRole — 自我保护 + canChangeRole + 最后 SA ============
  describe('updateRole — self-protect / canChangeRole / last-super-admin', () => {
    it('改自己 role → CANNOT_OPERATE_SELF;不查库(self-check 在 findFirst 之前)', async () => {
      const prisma = makePrismaMock();
      const service = makeService(prisma);

      await expect(
        service.updateRole(makeCurrentUser({ id: 'admin-1' }), 'admin-1', makeRoleDto(Role.ADMIN)),
      ).rejects.toEqual(new BizException(BizCode.CANNOT_OPERATE_SELF));
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    });

    it('ADMIN 改角色(canChangeRole deny:actor≠SA)→ FORBIDDEN_ROLE_OPERATION;不 update', async () => {
      const prisma = makePrismaMock();
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-2',
        role: Role.USER,
        status: UserStatus.ACTIVE,
      });
      const service = makeService(prisma);

      await expect(
        service.updateRole(
          makeCurrentUser({ id: 'admin-1', role: Role.ADMIN }),
          'u-2',
          makeRoleDto(Role.ADMIN),
        ),
      ).rejects.toEqual(new BizException(BizCode.FORBIDDEN_ROLE_OPERATION));
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('SA 降级最后一个 SUPER_ADMIN(remaining=0)→ LAST_SUPER_ADMIN_PROTECTED;不 update', async () => {
      const prisma = makePrismaMock();
      const lastAdminProtection = makeLastAdminProtectionMock();
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-2',
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      });
      lastAdminProtection.assertCanRemoveSuperAdmin.mockRejectedValue(
        new BizException(BizCode.LAST_SUPER_ADMIN_PROTECTED),
      );
      const service = makeService(prisma, { lastAdminProtection });

      await expect(
        service.updateRole(makeCurrentUser({ id: 'admin-1' }), 'u-2', makeRoleDto(Role.USER)),
      ).rejects.toEqual(new BizException(BizCode.LAST_SUPER_ADMIN_PROTECTED));
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('SA 降级 SUPER_ADMIN(remaining≥1)→ update role', async () => {
      const prisma = makePrismaMock();
      const lastAdminProtection = makeLastAdminProtectionMock();
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-2',
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      });
      prisma.user.update.mockResolvedValue(makeSafeUser({ id: 'u-2', role: Role.USER }));
      const service = makeService(prisma, { lastAdminProtection });

      const res = await service.updateRole(
        makeCurrentUser({ id: 'admin-1' }),
        'u-2',
        makeRoleDto(Role.USER),
      );

      const updateArg = prisma.user.update.mock.calls[0][0] as { data: { role: Role } };
      expect(updateArg.data.role).toBe(Role.USER);
      expect(res.role).toBe(Role.USER);
      expect(lastAdminProtection.assertCanRemoveSuperAdmin).toHaveBeenCalledWith(prisma, 'u-2');
    });

    it('SA 把 USER 升 ADMIN(目标非 SA)→ update;不做 last-SA count', async () => {
      const prisma = makePrismaMock();
      const lastAdminProtection = makeLastAdminProtectionMock();
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-2',
        role: Role.USER,
        status: UserStatus.ACTIVE,
      });
      prisma.user.update.mockResolvedValue(makeSafeUser({ id: 'u-2', role: Role.ADMIN }));
      const service = makeService(prisma, { lastAdminProtection });

      await service.updateRole(makeCurrentUser({ id: 'admin-1' }), 'u-2', makeRoleDto(Role.ADMIN));

      expect(lastAdminProtection.assertCanRemoveSuperAdmin).not.toHaveBeenCalled();
      const updateArg = prisma.user.update.mock.calls[0][0] as { data: { role: Role } };
      expect(updateArg.data.role).toBe(Role.ADMIN);
    });
  });

  // ============ 8. admin updateStatus — DISABLE 自我保护 + 最后 SA + 条件撤销 ============
  describe('updateStatus — self-protect on DISABLE / last-SA / conditional revoke', () => {
    it('禁用自己 → CANNOT_OPERATE_SELF;不 update', async () => {
      const prisma = makePrismaMock();
      prisma.user.findFirst.mockResolvedValue({
        id: 'admin-1',
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      });
      const service = makeService(prisma);

      await expect(
        service.updateStatus(
          makeCurrentUser({ id: 'admin-1' }),
          'admin-1',
          makeStatusDto(UserStatus.DISABLED),
        ),
      ).rejects.toEqual(new BizException(BizCode.CANNOT_OPERATE_SELF));
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('禁用最后一个 SUPER_ADMIN → LAST_SUPER_ADMIN_PROTECTED;不 update', async () => {
      const prisma = makePrismaMock();
      const lastAdminProtection = makeLastAdminProtectionMock();
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-2',
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      });
      lastAdminProtection.assertCanRemoveSuperAdmin.mockRejectedValue(
        new BizException(BizCode.LAST_SUPER_ADMIN_PROTECTED),
      );
      const service = makeService(prisma, { lastAdminProtection });

      await expect(
        service.updateStatus(
          makeCurrentUser({ id: 'admin-1' }),
          'u-2',
          makeStatusDto(UserStatus.DISABLED),
        ),
      ).rejects.toEqual(new BizException(BizCode.LAST_SUPER_ADMIN_PROTECTED));
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('禁用最后一个 ops-admin 持有人 → LAST_OPS_ADMIN_PROTECTED;不 update', async () => {
      const prisma = makePrismaMock();
      const lastAdminProtection = makeLastAdminProtectionMock();
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-2',
        role: Role.USER,
        status: UserStatus.ACTIVE,
      });
      lastAdminProtection.assertCanDeactivateOpsAdminUser.mockRejectedValue(
        new BizException(BizCode.LAST_OPS_ADMIN_PROTECTED),
      );
      const service = makeService(prisma, { lastAdminProtection });

      await expect(
        service.updateStatus(
          makeCurrentUser({ id: 'admin-1' }),
          'u-2',
          makeStatusDto(UserStatus.DISABLED),
        ),
      ).rejects.toEqual(new BizException(BizCode.LAST_OPS_ADMIN_PROTECTED));
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('禁用普通用户 → update status=DISABLED + 撤销目标 refresh(admin-disable)', async () => {
      const prisma = makePrismaMock();
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-2',
        role: Role.USER,
        status: UserStatus.ACTIVE,
      });
      prisma.user.update.mockResolvedValue(
        makeSafeUser({ id: 'u-2', status: UserStatus.DISABLED }),
      );
      const service = makeService(prisma);

      await service.updateStatus(
        makeCurrentUser({ id: 'admin-1' }),
        'u-2',
        makeStatusDto(UserStatus.DISABLED),
      );

      const updateArg = prisma.user.update.mock.calls[0][0] as { data: { status: UserStatus } };
      expect(updateArg.data.status).toBe(UserStatus.DISABLED);
      const revokeArg = prisma.refreshToken.updateMany.mock.calls[0][0] as {
        data: { revokedReason: string };
      };
      expect(revokeArg.data.revokedReason).toBe('admin-disable');
    });

    it('启用用户(ACTIVE)→ update status;**不**撤销 refresh', async () => {
      const prisma = makePrismaMock();
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-2',
        role: Role.USER,
        status: UserStatus.DISABLED,
      });
      prisma.user.update.mockResolvedValue(makeSafeUser({ id: 'u-2', status: UserStatus.ACTIVE }));
      const service = makeService(prisma);

      await service.updateStatus(
        makeCurrentUser({ id: 'admin-1' }),
        'u-2',
        makeStatusDto(UserStatus.ACTIVE),
      );

      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });
  });

  // ============ 9. admin softDelete — 自我保护 + 最后 SA + 撤销 ============
  describe('softDelete — self-protect / last-SA / revoke', () => {
    it('删自己 → CANNOT_OPERATE_SELF;self-check 在 findFirst 之前', async () => {
      const prisma = makePrismaMock();
      const service = makeService(prisma);

      await expect(
        service.softDelete(makeCurrentUser({ id: 'admin-1' }), 'admin-1'),
      ).rejects.toEqual(new BizException(BizCode.CANNOT_OPERATE_SELF));
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    });

    it('软删最后一个 SUPER_ADMIN → LAST_SUPER_ADMIN_PROTECTED;不 update', async () => {
      const prisma = makePrismaMock();
      const lastAdminProtection = makeLastAdminProtectionMock();
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-2',
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      });
      lastAdminProtection.assertCanRemoveSuperAdmin.mockRejectedValue(
        new BizException(BizCode.LAST_SUPER_ADMIN_PROTECTED),
      );
      const service = makeService(prisma, { lastAdminProtection });

      await expect(service.softDelete(makeCurrentUser({ id: 'admin-1' }), 'u-2')).rejects.toEqual(
        new BizException(BizCode.LAST_SUPER_ADMIN_PROTECTED),
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('软删最后一个 ops-admin 持有人 → LAST_OPS_ADMIN_PROTECTED;不 update', async () => {
      const prisma = makePrismaMock();
      const lastAdminProtection = makeLastAdminProtectionMock();
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-2',
        role: Role.USER,
        status: UserStatus.ACTIVE,
      });
      lastAdminProtection.assertCanDeactivateOpsAdminUser.mockRejectedValue(
        new BizException(BizCode.LAST_OPS_ADMIN_PROTECTED),
      );
      const service = makeService(prisma, { lastAdminProtection });

      await expect(service.softDelete(makeCurrentUser({ id: 'admin-1' }), 'u-2')).rejects.toEqual(
        new BizException(BizCode.LAST_OPS_ADMIN_PROTECTED),
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('成功 → update{deletedAt:Date, status:DISABLED} + 撤销目标 refresh(admin-delete)', async () => {
      const prisma = makePrismaMock();
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-2',
        role: Role.USER,
        status: UserStatus.ACTIVE,
      });
      prisma.user.update.mockResolvedValue(
        makeSafeUser({ id: 'u-2', status: UserStatus.DISABLED }),
      );
      const service = makeService(prisma);

      await service.softDelete(makeCurrentUser({ id: 'admin-1' }), 'u-2');

      const updateArg = prisma.user.update.mock.calls[0][0] as {
        data: { deletedAt: unknown; status: UserStatus };
      };
      expect(updateArg.data.deletedAt).toBeInstanceOf(Date);
      expect(updateArg.data.status).toBe(UserStatus.DISABLED);
      const revokeArg = prisma.refreshToken.updateMany.mock.calls[0][0] as {
        data: { revokedReason: string };
      };
      expect(revokeArg.data.revokedReason).toBe('admin-delete');
    });
  });

  // 微信 T3 review 收口(2026-06-12 增量审计⑬):bindMyWechat P2002 兜底触达。
  // 上方既有用例不触达 wechat 方法;本组只锁兜底 catch(含 §5 数组判断铁律),
  // 主流程 / 掩码 / 幂等由 app-me-wechat e2e 锁定。
  describe('bindMyWechat — P2002 兜底', () => {
    function primeBindUntilTx(prisma: PrismaMock, wechat: WechatMock): void {
      wechat.code2session.mockResolvedValue({ openid: 'o-conflict-1234567890' });
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-1',
        openid: null,
      } as unknown as SafeUserRow);
      prisma.user.findUnique.mockResolvedValue(null); // 占用预检未命中(竞态窗口)
    }

    it('事务撞 User_openid_key(P2002 target 含 openid)→ WECHAT_ALREADY_BOUND', async () => {
      const prisma = makePrismaMock();
      const wechat = makeWechatMock();
      primeBindUntilTx(prisma, wechat);
      prisma.user.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '6.19.3',
          meta: { target: ['openid'] },
        }),
      );
      const service = makeService(prisma, { wechat });

      await expect(
        service.bindMyWechat(
          makeCurrentUser({ id: 'u-1', role: Role.USER }),
          { code: 'wx-c' },
          META,
        ),
      ).rejects.toEqual(new BizException(BizCode.WECHAT_ALREADY_BOUND));
    });

    it('P2002 但 target 不含 openid → 原样上抛(§5 数组判断铁律,不误吞他键冲突)', async () => {
      const prisma = makePrismaMock();
      const wechat = makeWechatMock();
      primeBindUntilTx(prisma, wechat);
      const otherConflict = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '6.19.3',
        meta: { target: ['phone'] },
      });
      prisma.user.update.mockRejectedValue(otherConflict);
      const service = makeService(prisma, { wechat });

      await expect(
        service.bindMyWechat(
          makeCurrentUser({ id: 'u-1', role: Role.USER }),
          { code: 'wx-c' },
          META,
        ),
      ).rejects.toBe(otherConflict);
    });
  });
});
