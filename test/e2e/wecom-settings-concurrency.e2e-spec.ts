import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';

import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 企业微信 T2 收口 W1(2026-08-01):`updateSettings` 锁后复读行为锁 —— S1 形状真并发 e2e
//
// **修复前的交错**(整批评审 P1 ③;主会话已复现):
//   `updateSettings` 先 `findFirst`(**不带锁**)→ 再 `SELECT … FOR UPDATE` → 然后拿**锁前**的
//   `existing` 去算 enabled / loginEnabled / messageEnabled 的终态。两个并发请求都在对方提交前
//   读到同一份旧行,于是各自的"组合不变量"校验都通过,合起来写出
//   `enabled=false + loginEnabled=true` —— 一个自相矛盾却"两边都保存成功"的配置。
//
// **测试编排**(不是被测语义的一部分):
//   第三条连接持 `LOCK TABLE "wecom_settings" IN SHARE MODE`。
//   - 两条 HTTP 事务的 `findFirst`(纯 SELECT)**不受阻**       → 都读到旧行(这正是要钉住的窗口)
//   - `SELECT … FOR UPDATE` 取 RowShareLock,与 ShareLock 不冲突 → 先到者拿到行锁,后到者排队
//   - 先到者的 `UPDATE` 要 RowExclusiveLock,与 ShareLock **冲突** → 卡住,无法提交
//   等到两条都卡住(pg_stat_activity 有 2 个 Lock waiter)再释放屏障,窗口就被钉死了。
//
// ⚠️ 屏障窗口必须远小于 Prisma 交互事务的 5s 预算 —— 否则用例会以 P2028 红盖住真判据
//   (并发审计踩过:窗给 15s,轮询自己跑 14.6s)。这里两条请求毫秒级到位,轮询上限 3s。
//
// ⚠️ `datname = current_database()` 不可省:pg_stat_activity 是**实例级**视图,
//   而 per-worker 测试库由 `CREATE DATABASE … TEMPLATE` 克隆,别的 worker 的等待者会被计进来
//   → 屏障提前放行 → 两条请求退化为串行 → 断言照样通过(假绿)。

const ADMIN_USERNAME = 'wc-conc-adm';
const BASE = '/api/system/v1/wecom-settings';

const WECOM_PERMISSIONS = [
  { code: 'wecom-setting.read.singleton', action: 'read', resourceType: 'singleton' },
  { code: 'wecom-setting.update.singleton', action: 'update', resourceType: 'singleton' },
] as const;

async function seedWecomPermissions(app: INestApplication, opsAdminRoleId: string): Promise<void> {
  const prisma = app.get(PrismaService);
  for (const p of WECOM_PERMISSIONS) {
    const perm = await prisma.permission.upsert({
      where: { code: p.code },
      update: {},
      create: {
        code: p.code,
        module: 'wecom-setting',
        action: p.action,
        resourceType: p.resourceType,
      },
      select: { id: true },
    });
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: opsAdminRoleId, permissionId: perm.id } },
      update: {},
      create: { roleId: opsAdminRoleId, permissionId: perm.id },
    });
  }
}

describe('wecom-settings updateSettings 真并发(S1 锁后复读行为锁)', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let adminAuth: string;

  beforeAll(async () => {
    appA = await createTestApp();
    appB = await createTestApp();
    await resetDb(appA);
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);

    const admin = await createTestUser(appA, { username: ADMIN_USERNAME, role: Role.ADMIN });
    const { opsAdminRoleId } = await seedRbacPermissionsAndOpsAdmin(appA);
    await seedWecomPermissions(appA, opsAdminRoleId);
    await grantOpsAdminToUser(appA, admin.id, opsAdminRoleId);
    adminAuth = (await loginAs(appA, ADMIN_USERNAME)).authHeader;
  });

  afterAll(async () => {
    await Promise.all([appA.close(), appB.close()]);
  });

  beforeEach(async () => {
    await prismaA.auditLog.deleteMany({ where: { resourceType: 'wecom_setting' } });
    await prismaA.wecomSettings.deleteMany();
    // 起点:总闸开着、两个二级闸都关着 —— 两条请求各自单看都是合法变更
    await prismaA.wecomSettings.create({
      data: {
        providerType: 'DEV_STUB',
        enabled: true,
        loginEnabled: false,
        messageEnabled: false,
      },
    });
  });

  /** 等到确实有 `expected` 条连接卡在 wecom_settings 相关的锁上(不用 sleep:sleep 要么不够要么太长)。 */
  async function waitForSettingsLockWaiters(expected: number): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const [row] = await prismaB.$queryRaw<Array<{ waitingCount: number }>>`
        SELECT count(*)::int AS "waitingCount"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query LIKE '%wecom_settings%'
      `;
      if ((row?.waitingCount ?? 0) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`expected at least ${expected} wecom_settings lock waiter(s)`);
  }

  function patchVia(app: INestApplication, payload: Record<string, unknown>): request.Test {
    return request(httpServer(app)).patch(BASE).set('Authorization', adminAuth).send(payload);
  }

  /**
   * 两条 PATCH 在同一屏障窗口内并发跑完,返回两边状态码 + 最终行。
   * 屏障由 appA 的池外第三条连接持有,`first` 走 appA、`second` 走 appB(两套独立 Nest / Prisma 池)。
   */
  async function raceUnderBarrier(
    first: Record<string, unknown>,
    second: Record<string, unknown>,
  ): Promise<{ statuses: number[]; row: { enabled: boolean; loginEnabled: boolean } }> {
    let signalBlockerReady!: () => void;
    let releaseBlocker!: () => void;
    const blockerReady = new Promise<void>((resolve) => {
      signalBlockerReady = resolve;
    });
    const blockerRelease = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blocker = prismaA.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('LOCK TABLE "wecom_settings" IN SHARE MODE');
      signalBlockerReady();
      await blockerRelease;
    });

    await blockerReady;
    const attempts = Promise.all([patchVia(appA, first), patchVia(appB, second)]);
    try {
      // 两条都到位(一条卡在 UPDATE 的表锁上,一条卡在对方的行锁上)才放行
      await waitForSettingsLockWaiters(2);
    } finally {
      releaseBlocker();
      await blocker;
    }

    const results = await attempts;
    const row = await prismaA.wecomSettings.findFirstOrThrow({
      select: { enabled: true, loginEnabled: true },
    });
    return { statuses: results.map((r) => r.status).sort((a, b) => a - b), row };
  }

  // 两个顺序都测:先到者是谁不该改变结论。修复前**两序都会**写出矛盾组合。
  it.each([
    ['序①  enabled:false ∥ loginEnabled:true', { enabled: false }, { loginEnabled: true }],
    ['序②  loginEnabled:true ∥ enabled:false', { loginEnabled: true }, { enabled: false }],
  ])('%s → 不得写出 enabled=false + loginEnabled=true', async (_label, first, second) => {
    expect(prismaA).not.toBe(prismaB);
    expect(appA.getHttpServer()).not.toBe(appB.getHttpServer());

    const { statuses, row } = await raceUnderBarrier(first, second);

    // 核心判据:终态**永不**自相矛盾(二级闸开着而总闸关着)
    expect({ enabled: row.enabled, loginEnabled: row.loginEnabled }).not.toEqual({
      enabled: false,
      loginEnabled: true,
    });

    // 后到者必须看见先到者已提交的事实,并据此拒绝 —— 恰一条 200 + 恰一条 400。
    // 若两条都 200,说明后到者仍在用锁前快照判断(即修复前的行为)。
    expect(statuses).toEqual([200, 400]);
  });

  it('反向对照:两条互不冲突的变更并发 → 双 200,两个字段各自落库(不误杀)', async () => {
    const { statuses, row } = await raceUnderBarrier({ remarks: '甲' }, { messageEnabled: false });
    expect(statuses).toEqual([200, 200]);
    expect(row.enabled).toBe(true);
    const full = await prismaA.wecomSettings.findFirstOrThrow();
    expect(full.remarks).toBe('甲');
    expect(full.messageEnabled).toBe(false);
  });
});
