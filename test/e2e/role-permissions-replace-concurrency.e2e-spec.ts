import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// P1-32 PR 4a(2026-08-23):`PUT /roles/:id/permissions` 整集替换的**真并发**行为锁。
//
// 🔴 **这一条是本刀的核心断言,必须是真跑的 e2e + 真并发(两条真连接)**。
//    行锁与事务隔离在单测 mock 里根本不存在 —— 用 mock 写这条等于什么都没测,
//    而「摘掉行锁」那次变异对拍也就永远不会红。
//
// **要钉住的窗口**:整集替换是「读现状 → 算目标 → 整体写回」的读-改-写。
//   两个管理员各自从版本 N 出发提交不同的目标集,若没有角色行锁 + 版本号,
//   两条事务会各自读到 N、各自算差集、各自写回,于是:
//     · 两边都拿 200(都以为自己保存成功了);
//     · 库里落成两个目标集的**并集**,谁的意图都没实现;
//     · 先写那次的改动**静默消失**,没有任何一处报错。
//   ⚠️ 别把它读成「原来一直有并发 bug」—— 旧 `POST`(加码)/ `DELETE`(减码)语义**可交换**,
//      两个人各加一条码结果是两条都在,没有丢更新。窗口是 `PUT` 这个新语义带进来的,
//      所以行锁与版本号跟它同刀落地,不是补旧洞。
//
// **测试编排**(不是被测语义的一部分,照抄 wecom-settings-concurrency 的 S1 范式):
//   第三条连接持 `LOCK TABLE "role_permissions" IN SHARE MODE`。
//   - 两条 HTTP 事务的 `SELECT … FROM "roles" … FOR UPDATE` 取的是 roles 上的 RowShareLock,
//     与 role_permissions 的 ShareLock **不冲突** → 先到者拿到角色行锁,后到者在这里排队;
//   - 先到者接着要写 role_permissions(RowExclusiveLock)→ 与 ShareLock **冲突** → 卡住;
//   ⇒ 稳定态是「一条卡在表锁上、一条卡在角色行锁上」,共 2 个 waiter。
//   摘掉行锁之后,稳定态变成「两条都卡在表锁上」,同样 2 个 waiter —— 屏障对两种实现都成立,
//   所以它不会把变异对拍变成「屏障超时假红」。
//
// ⚠️ 屏障窗口必须远小于 Prisma 交互事务的 5s 预算,否则真症状会被 P2028 超时红盖住
//   (并发审计踩过:窗给 15s,轮询自己跑 14.6s)。这里两条请求毫秒级到位,轮询上限 3s。
//
// ⚠️ `datname = current_database()` 不可省:pg_stat_activity 是**实例级**视图,
//   per-worker 测试库由 `CREATE DATABASE … TEMPLATE` 克隆,别的 worker 的等待者会被计进来
//   → 屏障提前放行 → 两条请求退化为串行 → 断言照样通过(假绿)。

const SA_USERNAME = 'rp-conc-su';
const ROLE_CODE = 'rp-conc-target';

/** 两个目标集**刻意不相交**:摘掉行锁后落库的是并集(4 条),症状响亮且不会被唯一约束遮蔽。 */
const TARGET_A = ['rpconc.a.one', 'rpconc.a.two'];
const TARGET_B = ['rpconc.b.one', 'rpconc.b.two'];
const ALL_CODES = [...TARGET_A, ...TARGET_B];

describe('role-permissions PUT 整集替换 · 真并发(P1-32 PR 4a 行锁 + 版本号)', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let saAuth: string;
  let roleId: string;

  beforeAll(async () => {
    appA = await createTestApp();
    appB = await createTestApp();
    await resetDb(appA);
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);

    await createTestUser(appA, { username: SA_USERNAME, role: Role.SUPER_ADMIN });
    saAuth = (await loginAs(appA, SA_USERNAME)).authHeader;
    // rbac.role-permission.{create,delete} 两条码必须在库里(判权直读 DB)
    await seedRbacPermissionsAndOpsAdmin(appA);

    for (const code of ALL_CODES) {
      const [module, action, resourceType] = code.split('.');
      await prismaA.permission.upsert({
        where: { code },
        update: {},
        create: { code, module, action, resourceType },
      });
    }
  });

  afterAll(async () => {
    await Promise.all([appA.close(), appB.close()]);
  });

  beforeEach(async () => {
    await prismaA.auditLog.deleteMany({ where: { resourceType: 'role_permission' } });
    await prismaA.rbacRole.deleteMany({ where: { code: ROLE_CODE } });
    const role = await prismaA.rbacRole.create({
      data: { code: ROLE_CODE, displayName: '并发靶子角色' },
      select: { id: true, permissionRevision: true },
    });
    roleId = role.id;
    expect(role.permissionRevision).toBe(0);
  });

  /** 等到确实有 `expected` 条连接卡在角色 / 映射相关的锁上(不 sleep:sleep 要么不够要么太长)。 */
  async function waitForLockWaiters(expected: number): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const [row] = await prismaB.$queryRaw<Array<{ waitingCount: number }>>`
        SELECT count(*)::int AS "waitingCount"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND (query LIKE '%role_permissions%' OR query LIKE '%"roles"%')
      `;
      if ((row?.waitingCount ?? 0) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`expected at least ${expected} role/role_permission lock waiter(s)`);
  }

  function putVia(app: INestApplication, body: Record<string, unknown>): request.Test {
    return request(httpServer(app))
      .put(`/api/system/v1/roles/${roleId}/permissions`)
      .set('Authorization', saAuth)
      .send(body);
  }

  function postVia(app: INestApplication, permissionCodes: string[]): request.Test {
    return request(httpServer(app))
      .post(`/api/system/v1/roles/${roleId}/permissions`)
      .set('Authorization', saAuth)
      .send({ permissionCodes });
  }

  /** 两条请求在同一屏障窗口内并发跑完;`first` 走 appA、`second` 走 appB(两套独立 Nest / Prisma 池)。 */
  async function raceUnderBarrier(
    first: () => request.Test,
    second: () => request.Test,
  ): Promise<{ responses: request.Response[]; codes: Set<string>; revision: number }> {
    let signalBlockerReady!: () => void;
    let releaseBlocker!: () => void;
    const blockerReady = new Promise<void>((resolve) => {
      signalBlockerReady = resolve;
    });
    const blockerRelease = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blocker = prismaA.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('LOCK TABLE "role_permissions" IN SHARE MODE');
      signalBlockerReady();
      await blockerRelease;
    });

    await blockerReady;
    const attempts = Promise.all([first(), second()]);
    try {
      await waitForLockWaiters(2);
    } finally {
      releaseBlocker();
      await blocker;
    }

    const responses = await attempts;
    const rows = await prismaA.rolePermission.findMany({
      where: { roleId },
      select: { permission: { select: { code: true } } },
    });
    const role = await prismaA.rbacRole.findUniqueOrThrow({
      where: { id: roleId },
      select: { permissionRevision: true },
    });
    return {
      responses,
      codes: new Set(rows.map((r) => r.permission.code)),
      revision: role.permissionRevision,
    };
  }

  // 两个顺序都测:谁先到不该改变结论。摘掉行锁时**两序都会**落成并集。
  it.each([
    ['序① A ∥ B', TARGET_A, TARGET_B],
    ['序② B ∥ A', TARGET_B, TARGET_A],
  ])(
    '%s —— 同一个 expectedRevision 的两个并发 PUT:恰一个成功、恰一个拿 30111,终态 = 成功那次的目标集',
    async (_label, firstTarget, secondTarget) => {
      // 编排自证:两条请求必须真的走两套独立实例,否则「并发」只是同一个池里排队。
      expect(prismaA).not.toBe(prismaB);
      expect(appA.getHttpServer()).not.toBe(appB.getHttpServer());

      const { responses, codes, revision } = await raceUnderBarrier(
        () => putVia(appA, { permissionCodes: firstTarget, expectedRevision: 0 }),
        () => putVia(appB, { permissionCodes: secondTarget, expectedRevision: 0 }),
      );

      // ① 恰一个成功、恰一个冲突 —— 两个 200 就是丢更新(后写覆盖先写,先写那次静默消失)
      const statuses = responses.map((r) => r.status).sort((a, b) => a - b);
      expect(statuses).toEqual([200, BizCode.ROLE_PERMISSION_REVISION_CONFLICT.httpStatus]);
      const conflicted = responses.filter((r) => r.status !== 200);
      expect(conflicted).toHaveLength(1);
      expect(conflicted[0].body.code).toBe(BizCode.ROLE_PERMISSION_REVISION_CONFLICT.code);

      // ② 终态**等于成功那次的目标集**,不是并集、不是空集
      const winnerIndex = responses.findIndex((r) => r.status === 200);
      const winnerTarget = winnerIndex === 0 ? firstTarget : secondTarget;
      expect(codes).toEqual(new Set(winnerTarget));
      // 反面钉死:并集(4 条)是「行锁没了」的指纹,单独点名它
      expect(codes.size).toBe(2);
      expect(codes).not.toEqual(new Set(ALL_CODES));

      // ③ 版本号只推进一次 —— 两次 +1 说明两条事务都写成功了
      expect(revision).toBe(1);

      // ④ audit 也只有一条:被拒那次一个字节都没写
      const audits = await prismaA.auditLog.count({
        where: { resourceType: 'role_permission', resourceId: roleId },
      });
      expect(audits).toBe(1);
    },
  );

  // 🔴 反向对照,**不能省**:上面那条若被一个「PUT 一律返 30111」的实现满足,也会全绿。
  //    这里证明同一套屏障编排下,两条**语义可交换**的旧写路径(POST 加码)照样双双成功 ——
  //    行锁只是让它们串行,不误杀。顺带把「旧 POST / DELETE 是可交换的」这条前提
  //    (本刀 changelog 的立论基础)钉在行为面上,而不是只写在注释里。
  //
  //    ⭐ 它还兼职守住一条**实现层的坑**:原语收的是「意图」(add / remove / set)而不是
  //    「目标全集」。若有人图省事,让 POST 在锁**外**先读一遍现状、算出目标全集再交进来,
  //    那份快照会在锁等待期间过期 —— 后到那条 POST 会拿着「空集 ∪ B」当目标,
  //    把先到者刚加的 A 一起删掉。届时本用例的终态会是 `B` 而不是并集,当场红。
  it('反向对照:两个并发 POST(可交换的加码)→ 双双成功,终态 = 并集,版本号 +2', async () => {
    const { responses, codes, revision } = await raceUnderBarrier(
      () => postVia(appA, TARGET_A),
      () => postVia(appB, TARGET_B),
    );

    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    expect(codes).toEqual(new Set(ALL_CODES));
    expect(revision).toBe(2);
  });
});
