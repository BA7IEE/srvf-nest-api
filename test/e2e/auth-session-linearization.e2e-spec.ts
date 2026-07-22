import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import { AuditLogsService } from '../../src/modules/audit-logs/audit-logs.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { AuthService } from '../../src/modules/auth/auth.service';
import { LoginSmsService } from '../../src/modules/auth/login-sms.service';
import { LoginWechatService } from '../../src/modules/auth/login-wechat.service';
import { PasswordResetService } from '../../src/modules/auth/password-reset.service';
import { MembersService } from '../../src/modules/members/members.service';
import { UsersService } from '../../src/modules/users/users.service';
import { WechatService } from '../../src/modules/wechat/wechat.service';
import { createTestUser, TEST_PASSWORD } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// D-PR1：两套 Nest app / 两个 Prisma pool / 真实 PostgreSQL User 行锁屏障。
// 每个竞态先由独立事务持有 User FOR UPDATE，再逐个把两个生产路径放入同一锁队列；
// pg_stat_activity + pg_blocking_pids 是“请求确实在数据库锁上等待”的验收证据。

const META: AuditMeta = { requestId: 'auth-session-linearization', ip: '127.0.0.1', ua: 'jest' };
const FIXED_SMS_CODE = '888888';
// 独立 Jest 进程首次启动 Prisma transaction/pool 时，5s 观测窗在本地已建测试库上
// 可稳定早于 waiter 入队而误报。这里仅扩大等待预算，不减少 waiter 数、direct blocker
// 或 SQL 形状要求；holder timeout 留出两轮 waiter 观测与失败诊断的总预算。
const LOCK_WAITER_DEADLINE_MS = 10_000;
const BARRIER_TRANSACTION_TIMEOUT_MS = 25_000;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface UserLockWaiter {
  pid: number;
  query: string;
  blockingPids: number[];
}

function isTransitivelyBlockedBy(
  waiterPid: number,
  blockerPid: number,
  blockersByPid: ReadonlyMap<number, readonly number[]>,
  visited: Set<number> = new Set(),
): boolean {
  if (visited.has(waiterPid)) return false;
  visited.add(waiterPid);
  const directBlockers = blockersByPid.get(waiterPid) ?? [];
  return directBlockers.some(
    (directBlockerPid) =>
      directBlockerPid === blockerPid ||
      isTransitivelyBlockedBy(directBlockerPid, blockerPid, blockersByPid, new Set(visited)),
  );
}

async function waitForUserLockWaiters(
  prisma: PrismaService,
  blockerPid: number,
  expected: number,
): Promise<UserLockWaiter[]> {
  const deadline = performance.now() + LOCK_WAITER_DEADLINE_MS;
  while (performance.now() < deadline) {
    const lockWaiters = await prisma.$queryRaw<UserLockWaiter[]>`
      SELECT
        pid,
        query,
        pg_blocking_pids(pid) AS "blockingPids"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND state = 'active'
        AND wait_event_type = 'Lock'
      ORDER BY query_start, pid
    `;
    const blockersByPid = new Map(
      lockWaiters.map(({ pid, blockingPids }) => [pid, blockingPids] as const),
    );
    // PostgreSQL 可能把同一 User 的 UPDATE 排在 SELECT FOR UPDATE 前面；此时被测
    // waiter 通过 UPDATE 间接指回 holder。必须证明每个返回 waiter 都沿真实
    // pg_blocking_pids 链最终受原 holder 阻塞，不能只凭 SQL 形状或 waiter 数放行。
    const blockedUserWaiters = lockWaiters.filter(
      ({ pid, query }) =>
        query.includes('FROM "User"') &&
        query.includes('FOR UPDATE') &&
        isTransitivelyBlockedBy(pid, blockerPid, blockersByPid),
    );
    if (blockedUserWaiters.length >= expected) {
      return blockedUserWaiters;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const activity = await prisma.$queryRaw<
    Array<{
      pid: number;
      state: string;
      waitEventType: string | null;
      waitEvent: string | null;
      blockingPids: number[];
      query: string;
    }>
  >`
    SELECT
      pid,
      state,
      wait_event_type AS "waitEventType",
      wait_event AS "waitEvent",
      pg_blocking_pids(pid) AS "blockingPids",
      query
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND (wait_event_type = 'Lock' OR query LIKE '%"User"%')
    ORDER BY query_start, pid
  `;
  throw new Error(
    `expected ${expected} User FOR UPDATE waiter(s) blocked by pid ${blockerPid}; ` +
      `activity=${JSON.stringify(activity)}`,
  );
}

async function holdUserRow(
  prisma: PrismaService,
  userId: string,
): Promise<{ blockerPid: number; release: () => void; done: Promise<void> }> {
  const ready = deferred<number>();
  const release = deferred<void>();
  const done = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE
      `;
      const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_backend_pid()::integer AS pid
      `;
      if (!backend) throw new Error('User row-lock backend pid missing');
      ready.resolve(backend.pid);
      await release.promise;
    },
    { maxWait: 5_000, timeout: BARRIER_TRANSACTION_TIMEOUT_MS },
  );
  void done.catch((error: unknown) => ready.reject(error));
  return {
    blockerPid: await ready.promise,
    release: () => release.resolve(),
    done,
  };
}

function currentUser(id: string, role: Role = Role.USER): CurrentUserPayload {
  return { id, username: `actor-${id}`, role, status: UserStatus.ACTIVE, memberId: null };
}

function expectBizFailure(
  result: PromiseSettledResult<unknown>,
  code: typeof BizCode.LOGIN_FAILED,
): void;
function expectBizFailure(
  result: PromiseSettledResult<unknown>,
  code: typeof BizCode.SMS_CODE_INVALID,
): void;
function expectBizFailure(
  result: PromiseSettledResult<unknown>,
  code: typeof BizCode.WECHAT_CODE_INVALID,
): void;
function expectBizFailure(
  result: PromiseSettledResult<unknown>,
  code: typeof BizCode.REFRESH_TOKEN_INVALID,
): void;
function expectBizFailure(
  result: PromiseSettledResult<unknown>,
  code:
    | typeof BizCode.LOGIN_FAILED
    | typeof BizCode.SMS_CODE_INVALID
    | typeof BizCode.WECHAT_CODE_INVALID
    | typeof BizCode.REFRESH_TOKEN_INVALID,
): void {
  expect(result.status).toBe('rejected');
  if (result.status === 'rejected') expect(result.reason).toEqual(new BizException(code));
}

describe('Auth session lifecycle PostgreSQL linearization', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let barrierPrisma: PrismaService;
  let authA: AuthService;
  let authB: AuthService;
  let usersB: UsersService;
  let membersB: MembersService;
  let passwordResetB: PasswordResetService;
  let loginSmsA: LoginSmsService;
  let loginWechatA: LoginWechatService;
  let sequence = 0;

  beforeAll(async () => {
    appA = await createTestApp();
    appB = await createTestApp();
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);
    // 屏障独占第三条测试连接池，避免占用 app A/B 的业务连接；两个被测请求仍分别
    // 来自两套 Nest app 的独立 Prisma pool。
    barrierPrisma = new PrismaService();
    await barrierPrisma.$connect();
    authA = appA.get(AuthService);
    authB = appB.get(AuthService);
    usersB = appB.get(UsersService);
    membersB = appB.get(MembersService);
    passwordResetB = appB.get(PasswordResetService);
    loginSmsA = appA.get(LoginSmsService);
    loginWechatA = appA.get(LoginWechatService);
  });

  beforeEach(async () => {
    await resetDb(appA);
    await prismaA.smsSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    sequence += 1;
  });

  afterAll(async () => {
    await Promise.all([appA.close(), appB.close(), barrierPrisma.$disconnect()]);
  });

  async function newTarget(suffix: string): Promise<Awaited<ReturnType<typeof createTestUser>>> {
    return createTestUser(appA, { username: `asl-${sequence}-${suffix}` });
  }

  async function newSuperAdmin(): Promise<CurrentUserPayload> {
    const actor = await createTestUser(appA, {
      username: `asl-${sequence}-super-admin`,
      role: Role.SUPER_ADMIN,
    });
    return currentUser(actor.id, Role.SUPER_ADMIN);
  }

  async function issuePasswordSession(user: { username: string }): Promise<string> {
    const session = await authA.login({ username: user.username, password: TEST_PASSWORD }, META);
    return session.refreshToken;
  }

  async function expectNoActiveRefresh(userId: string): Promise<void> {
    await expect(
      prismaA.refreshToken.count({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      }),
    ).resolves.toBe(0);
  }

  async function runRefreshThenMutation(
    userId: string,
    refreshToken: string,
    mutation: () => Promise<unknown>,
  ): Promise<PromiseSettledResult<unknown>[]> {
    const barrier = await holdUserRow(barrierPrisma, userId);
    const attempts: Promise<unknown>[] = [];
    let results: PromiseSettledResult<unknown>[] = [];
    try {
      const refresh = authA.refresh({ refreshToken }, META);
      attempts.push(refresh);
      void refresh.catch(() => undefined);
      const first = await waitForUserLockWaiters(prismaB, barrier.blockerPid, 1);
      expect(first[0]?.query).toContain('FOR UPDATE');

      const revoke = mutation();
      attempts.push(revoke);
      void revoke.catch(() => undefined);
      const both = await waitForUserLockWaiters(prismaA, barrier.blockerPid, 2);
      expect(both).toHaveLength(2);
    } finally {
      barrier.release();
      await barrier.done;
      results = await Promise.allSettled(attempts);
    }
    expect(results[0]?.status).toBe('fulfilled');
    expect(results[1]?.status).toBe('fulfilled');
    await expectNoActiveRefresh(userId);
    return results;
  }

  it('两个 Nest app 使用不同 PostgreSQL backend / pool', async () => {
    const [[a], [b]] = await Promise.all([
      prismaA.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::integer AS pid`,
      prismaB.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::integer AS pid`,
    ]);
    expect(a?.pid).toBeDefined();
    expect(b?.pid).toBeDefined();
    expect(a?.pid).not.toBe(b?.pid);
  });

  it('refresh 先线性化、本人改密后提交：新 sibling 也被撤销', async () => {
    const user = await newTarget('change-password');
    const raw = await issuePasswordSession(user);
    await runRefreshThenMutation(user.id, raw, () =>
      usersB.changeMyPassword(
        currentUser(user.id),
        { oldPassword: TEST_PASSWORD, newPassword: 'ChangedPass2!' },
        META,
      ),
    );
  });

  it('refresh 先线性化、短信找回后提交：新 sibling 也被撤销', async () => {
    const user = await newTarget('password-reset');
    const phone = `1391000${String(sequence).padStart(4, '0')}`;
    await prismaA.user.update({ where: { id: user.id }, data: { phone } });
    await passwordResetB.sendCode({ phone }, null);
    const raw = await issuePasswordSession(user);
    await runRefreshThenMutation(user.id, raw, () =>
      passwordResetB.reset({ phone, code: FIXED_SMS_CODE, newPassword: 'ResetPass2!' }, META),
    );
  });

  it('refresh 先线性化、logout-all 后提交：不存在 active sibling', async () => {
    const user = await newTarget('logout-all');
    const raw = await issuePasswordSession(user);
    await runRefreshThenMutation(user.id, raw, () => authB.logoutAll(currentUser(user.id), META));
  });

  it('refresh 先线性化、admin disable 后提交：账号禁用且不存在 active sibling', async () => {
    const actor = await newSuperAdmin();
    const user = await newTarget('admin-disable');
    const raw = await issuePasswordSession(user);
    await runRefreshThenMutation(user.id, raw, () =>
      usersB.updateStatus(actor, user.id, { status: UserStatus.DISABLED }, META),
    );
    await expect(prismaA.user.findUnique({ where: { id: user.id } })).resolves.toMatchObject({
      status: UserStatus.DISABLED,
    });
  });

  it('refresh 先线性化、member offboard 后提交：linked 账号禁用且不存在 active sibling', async () => {
    const actor = await newSuperAdmin();
    const member = await prismaA.member.create({
      data: {
        memberNo: `ASL-${sequence}`,
        displayName: `Session linearization ${sequence}`,
        status: MemberStatus.ACTIVE,
      },
    });
    const user = await newTarget('offboard');
    await prismaA.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    const raw = await issuePasswordSession(user);
    await runRefreshThenMutation(user.id, raw, () => membersB.offboard(member.id, actor, META));
    await expect(prismaA.user.findUnique({ where: { id: user.id } })).resolves.toMatchObject({
      status: UserStatus.DISABLED,
    });
  });

  it('rotation 先提交、rotated ancestor replay 后提交：replay 撤销新 sibling family', async () => {
    const user = await newTarget('replay-rotation');
    const oldRaw = await issuePasswordSession(user);
    const firstRotation = await authA.refresh({ refreshToken: oldRaw }, META);
    const barrier = await holdUserRow(barrierPrisma, user.id);
    const attempts: Promise<unknown>[] = [];
    let results: PromiseSettledResult<unknown>[] = [];
    try {
      const rotation = authA.refresh({ refreshToken: firstRotation.refreshToken }, META);
      attempts.push(rotation);
      void rotation.catch(() => undefined);
      await waitForUserLockWaiters(prismaB, barrier.blockerPid, 1);

      const replay = authB.refresh({ refreshToken: oldRaw }, META);
      attempts.push(replay);
      void replay.catch(() => undefined);
      await waitForUserLockWaiters(prismaA, barrier.blockerPid, 2);
    } finally {
      barrier.release();
      await barrier.done;
      results = await Promise.allSettled(attempts);
    }
    expect(results[0]?.status).toBe('fulfilled');
    if (results[1]) expectBizFailure(results[1], BizCode.REFRESH_TOKEN_INVALID);
    await expectNoActiveRefresh(user.id);
  });

  it('改密先线性化：等待中的旧 passwordHash 登录失败且零 refresh / 零 login audit', async () => {
    const user = await newTarget('stale-password-login');
    const barrier = await holdUserRow(barrierPrisma, user.id);
    const attempts: Promise<unknown>[] = [];
    let results: PromiseSettledResult<unknown>[] = [];
    try {
      const passwordChange = usersB.changeMyPassword(
        currentUser(user.id),
        { oldPassword: TEST_PASSWORD, newPassword: 'ChangedPass3!' },
        META,
      );
      attempts.push(passwordChange);
      void passwordChange.catch(() => undefined);
      await waitForUserLockWaiters(prismaA, barrier.blockerPid, 1);

      const staleLogin = authA.login({ username: user.username, password: TEST_PASSWORD }, META);
      attempts.push(staleLogin);
      void staleLogin.catch(() => undefined);
      await waitForUserLockWaiters(prismaB, barrier.blockerPid, 2);
    } finally {
      barrier.release();
      await barrier.done;
      results = await Promise.allSettled(attempts);
    }
    expect(results[0]?.status).toBe('fulfilled');
    if (results[1]) expectBizFailure(results[1], BizCode.LOGIN_FAILED);
    await expectNoActiveRefresh(user.id);
    await expect(
      prismaA.auditLog.count({ where: { actorUserId: user.id, event: 'auth.login' } }),
    ).resolves.toBe(0);
  });

  it('phone clear 先线性化：已消费验证码的旧手机号登录仍拒绝且零 session audit', async () => {
    const actor = await newSuperAdmin();
    const user = await newTarget('stale-sms-login');
    const phone = `1381000${String(sequence).padStart(4, '0')}`;
    await prismaA.user.update({ where: { id: user.id }, data: { phone } });
    await issuePasswordSession(user);
    await loginSmsA.sendCode({ phone }, null);
    const barrier = await holdUserRow(barrierPrisma, user.id);
    const attempts: Promise<unknown>[] = [];
    let results: PromiseSettledResult<unknown>[] = [];
    try {
      const clear = usersB.clearUserPhone(actor, user.id, META);
      attempts.push(clear);
      void clear.catch(() => undefined);
      await waitForUserLockWaiters(prismaA, barrier.blockerPid, 1);

      const staleLogin = loginSmsA.login({ phone, code: FIXED_SMS_CODE }, META);
      attempts.push(staleLogin);
      void staleLogin.catch(() => undefined);
      await waitForUserLockWaiters(prismaB, barrier.blockerPid, 2);
    } finally {
      barrier.release();
      await barrier.done;
      results = await Promise.allSettled(attempts);
    }
    expect(results[0]?.status).toBe('fulfilled');
    if (results[1]) expectBizFailure(results[1], BizCode.SMS_CODE_INVALID);
    await expectNoActiveRefresh(user.id);
    await expect(
      prismaA.auditLog.count({ where: { actorUserId: user.id, event: 'auth.login.sms' } }),
    ).resolves.toBe(0);
  });

  it('openid clear 先线性化：旧 openid 微信登录失败且零 session audit', async () => {
    const actor = await newSuperAdmin();
    const user = await newTarget('stale-wechat-login');
    const openid = `openid-session-linearization-${sequence}`;
    await prismaA.user.update({ where: { id: user.id }, data: { openid } });
    await issuePasswordSession(user);
    const codeSpy = jest
      .spyOn(appA.get(WechatService), 'code2session')
      .mockResolvedValue({ openid });
    const barrier = await holdUserRow(barrierPrisma, user.id);
    const attempts: Promise<unknown>[] = [];
    let results: PromiseSettledResult<unknown>[] = [];
    try {
      const clear = usersB.clearUserWechat(actor, user.id, META);
      attempts.push(clear);
      void clear.catch(() => undefined);
      await waitForUserLockWaiters(prismaA, barrier.blockerPid, 1);

      const staleLogin = loginWechatA.login({ code: 'synthetic-wx-code' }, META);
      attempts.push(staleLogin);
      void staleLogin.catch(() => undefined);
      await waitForUserLockWaiters(prismaB, barrier.blockerPid, 2);
    } finally {
      barrier.release();
      await barrier.done;
      results = await Promise.allSettled(attempts);
      codeSpy.mockRestore();
    }
    expect(results[0]?.status).toBe('fulfilled');
    if (results[1]) expectBizFailure(results[1], BizCode.WECHAT_CODE_INVALID);
    await expectNoActiveRefresh(user.id);
    await expect(
      prismaA.auditLog.count({ where: { actorUserId: user.id, event: 'auth.login.wechat' } }),
    ).resolves.toBe(0);
  });

  it('签发事务 audit 失败：refresh insert 同事务回滚，零 orphan refresh / 零假 audit', async () => {
    const user = await newTarget('rollback');
    const auditSpy = jest
      .spyOn(appA.get(AuditLogsService), 'log')
      .mockRejectedValueOnce(new Error('synthetic audit failure'));
    try {
      await expect(
        authA.createSession(
          user.id,
          { kind: 'password-hash', value: user.passwordHash },
          META,
          'auth.login',
        ),
      ).rejects.toThrow('synthetic audit failure');
    } finally {
      auditSpy.mockRestore();
    }
    await expectNoActiveRefresh(user.id);
    await expect(prismaA.auditLog.count({ where: { actorUserId: user.id } })).resolves.toBe(0);
  });
});
