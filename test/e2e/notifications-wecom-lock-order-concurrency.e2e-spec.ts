import type { INestApplication } from '@nestjs/common';
import { Prisma, type Notification, Role, UserStatus } from '@prisma/client';

import { PrismaService } from '../../src/database/prisma.service';
import { lockAuthSessionUser } from '../../src/modules/auth/auth-session-lock';
import {
  NOTIFICATION_AUDIENCE_BROADCAST,
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_CHANNEL_WECOM,
  NOTIFICATION_SOURCE_ADMIN,
  NOTIFICATION_STATUS_PUBLISHED,
  NOTIFICATION_VISIBILITY_MEMBER,
} from '../../src/modules/notifications/notification.constants';
import { NotificationWecomDispatchService } from '../../src/modules/notifications/notification-wecom-dispatch.service';
import { WecomSettingsService } from '../../src/modules/wecom/wecom-settings.service';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// ============================================================================
// 外部评审 F2 / B4 —— 共同实体相对锁序统一为 `settings → User → identity`
// ============================================================================
//
// **修复前的环**(评审给的五步调度)。三方各自都"很讲道理",合起来成环:
//
//   ① 绑定事务      BEGIN; wecom_settings FOR SHARE                       (持 S)
//   ② 最终闸        BEGIN; …; "User" FOR SHARE                            (持 S)
//   ③ PATCH settings BEGIN; wecom_settings FOR UPDATE                     (排队,等 ①)
//   ④ 最终闸        wecom_settings FOR SHARE                              (排队,等 ③)
//   ⑤ 绑定事务      "User" FOR UPDATE                                     (等 ②)⇒ 环闭合
//
// 第 ④ 步是关键、也是最反直觉的一步:`FOR SHARE` 与 `FOR SHARE` 本不冲突,但 PostgreSQL 的
// tuple lock 队列是 **FIFO**(防饿死)——③ 的 `FOR UPDATE` 等待者握着 tuple lock,
// 于是后到的 ④ 只能排在它**身后**。上一版判"不会成环"时枚举了 settings 的**写**者,
// 漏了绑定路径:它 `FOR SHARE` 读 settings,却同时 `FOR UPDATE` 持有 User。
//
// **修复后**:最终闸把 settings 的锁提到最前,于是它在等 settings 时**手里什么都没有**,
// ⑤ 的 `User FOR UPDATE` 立刻拿到 → ① 提交 → ③ 拿到 → ④ 拿到。环在结构上不存在。
//
// ⚠️ 本用例断言的是**没有死锁**,不是"跑一百次没遇到"。调度靠 pg_stat_activity 精确等待,
// 每一步都确认对手真的卡在锁上了才推进下一步。
//
// 三方的真实性:
//   - 最终闸 = **真实生产代码** `NotificationWecomDispatchService.authorizeDurableRecipient`
//   - PATCH  = **真实生产代码** `WecomSettingsService.updateSettings`
//   - 绑定   = 逐字复刻 `users/user-wecom-binding.service.ts` 的 `runRebindTransaction`
//             与 `auth/login-wecom.service.ts` 的 `runBindTransaction` 的前两条锁语句
//             (settings FOR SHARE → `lockAuthSessionUser`,后者是**真实导出的**共用原语)。
//             不整段调用真方法是因为它要 step-up proof / 短信码,那些与锁序无关。

const TYPE_CODE = 'f2-wecom-lock-order';
const AUDIT_META = { requestId: 'f2-lock-order', ip: '127.0.0.1', ua: 'jest' };
const CORP_ID = 'ww-f2-lockorder-0001';
const WEB_BASE_URL = 'https://srvf-f2-lock.example.org';
const TX_BUDGET = { timeout: 20_000, maxWait: 20_000 } as const;

/** 屏障用的一次性信号(不用 sleep:sleep 要么不够要么太长)。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('F2 / B4 —— 企业微信最终闸的锁序(真三连接 barrier)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let dispatch: NotificationWecomDispatchService;
  let settingsService: WecomSettingsService;

  let adminPayload: CurrentUserPayload;
  let notification: Notification;
  let memberId: string;
  let userId: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    dispatch = app.get(NotificationWecomDispatchService);
    settingsService = app.get(WecomSettingsService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(app);
    await prisma.dictType.create({
      data: {
        code: 'notification_type',
        label: '通知类型',
        items: { create: [{ code: TYPE_CODE, label: 'F2 锁序用例', status: 'ACTIVE' }] },
      },
    });
    const admin = await createTestUser(app, { username: 'f2_lock_admin', role: Role.SUPER_ADMIN });
    adminPayload = {
      id: admin.id,
      username: admin.username,
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };

    await prisma.wecomSettings.create({
      data: {
        providerType: 'DEV_STUB',
        enabled: true,
        loginEnabled: true,
        messageEnabled: true,
        corpId: CORP_ID,
        webBaseUrl: WEB_BASE_URL,
        credentialConfigured: false,
      },
    });

    const member = await prisma.member.create({
      data: {
        memberNo: 'F2LOCK001',
        displayName: 'F2 锁序队员',
        status: 'ACTIVE',
        gradeCode: 'level-3',
      },
      select: { id: true },
    });
    memberId = member.id;
    const user = await createTestUser(app, { username: 'f2_lock_member' });
    userId = user.id;
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    await prisma.wecomIdentity.create({
      data: {
        userId: user.id,
        corpId: CORP_ID,
        wecomUserId: 'wecom-user-lockorder',
        status: 'active',
        bindingSource: 'me',
      },
    });

    notification = await prisma.notification.create({
      data: {
        title: 'F2 锁序演练',
        body: '锁序验证专用。',
        notificationTypeCode: TYPE_CODE,
        statusCode: NOTIFICATION_STATUS_PUBLISHED,
        publishedAt: new Date(),
        visibilityCode: NOTIFICATION_VISIBILITY_MEMBER,
        audienceType: NOTIFICATION_AUDIENCE_BROADCAST,
        sourceType: NOTIFICATION_SOURCE_ADMIN,
        channels: [NOTIFICATION_CHANNEL_IN_APP, NOTIFICATION_CHANNEL_WECOM],
        authorUserId: admin.id,
      },
    });
  });

  /**
   * 等到确实有 `expected` 条连接卡在 `wecom_settings` 的锁上。
   *
   * ⚠️ `datname = current_database()` 不可省:pg_stat_activity 是**实例级**视图,
   * 而 per-worker 测试库由 `CREATE DATABASE … TEMPLATE` 克隆,别的 worker 的等待者
   * 会被计进来 → 屏障提前放行 → 三条事务退化为串行 → 断言照样通过(假绿)。
   */
  async function waitForSettingsWaiters(expected: number): Promise<void> {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const [row] = await prisma.$queryRaw<Array<{ waitingCount: number }>>`
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

  function isDeadlock(error: unknown): boolean {
    // PostgreSQL 40P01。Prisma 把它包成 P2010(raw query failed)并保留 message。
    return (
      error instanceof Error &&
      (/40P01/.test(error.message) || /deadlock detected/i.test(error.message))
    );
  }

  async function currentExpectation(): Promise<{
    corpId: string;
    configurationGeneration: string;
  }> {
    const active = await settingsService.getActiveSettings();
    expect(active).not.toBeNull();
    return {
      corpId: active!.corpId!,
      configurationGeneration: active!.configurationGeneration,
    };
  }

  /**
   * **本刀的主判据**:最终闸在等 `wecom_settings` 的那一刻,手里**不能**已经攥着 `User`。
   *
   * 这条比"跑一遍没死锁"硬得多,也正是让环**结构性**消失的那个性质:
   * 只要闸是"先 settings 后 User",它阻塞时就什么都没持有,绑定事务的 `User FOR UPDATE`
   * 必然能拿到 —— 无论第三方怎么排都构不成环。
   *
   * 三条连接:
   *   C 持 `wecom_settings FOR UPDATE`(模拟 PATCH 正在写)
   *   A 跑**真实**最终闸 ⇒ 必然卡在 settings 上
   *   B 在此时抢 `User FOR UPDATE`(**真实**共用原语 `lockAuthSessionUser`)
   *
   * 修复前 A 的锁序是 `… → User FOR SHARE → settings FOR SHARE`,于是 B 会被 A 手里的
   * User 共享锁挡住 ⇒ `lock_timeout` 触发 ⇒ 本用例红。
   */
  it('最终闸阻塞在 settings 时不持有 User —— 绑定路径的 User FOR UPDATE 仍能拿到', async () => {
    const expected = await currentExpectation();
    const patchHoldsSettings = deferred();
    const releasePatch = deferred();

    // ── C:PATCH 正在写 settings(FOR UPDATE 持有) ──
    const patchTx = prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "wecom_settings" ORDER BY "id" FOR UPDATE`);
      patchHoldsSettings.resolve();
      await releasePatch.promise;
    }, TX_BUDGET);

    await patchHoldsSettings.promise;

    // ── A:真实最终闸。新锁序下它的**第一条**语句就是 settings,当场卡住 ──
    let authorization: string | undefined;
    const gateTx = prisma.$transaction(async (tx) => {
      const result = await dispatch.authorizeDurableRecipient(tx, notification, memberId, expected);
      authorization = result.outcome;
    }, TX_BUDGET);

    await waitForSettingsWaiters(1);

    // ── B:绑定路径此刻抢 User。新锁序 ⇒ 立刻拿到;旧锁序 ⇒ 被闸持有的 User 共享锁挡住 ──
    let bindGotUser = false;
    let bindFailure: string | null = null;
    await prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '3s'`);
        bindGotUser = await lockAuthSessionUser(tx, userId);
      }, TX_BUDGET)
      .catch((error: unknown) => {
        bindGotUser = false;
        // 分开记:旧锁序下是"被闸攥着的 User 共享锁挡到 lock_timeout",不是死锁 ——
        // 两者的失败原因不同,红的时候要一眼看得出是哪一种。
        bindFailure = isDeadlock(error) ? 'deadlock' : 'blocked-by-gate';
      });

    releasePatch.resolve();
    await Promise.all([patchTx, gateTx]);

    expect(bindFailure).toBeNull();
    expect(bindGotUser).toBe(true);
    expect(authorization).toBe('authorized');
  });

  /**
   * 评审五步调度的**第 ④ 步为什么不成立** —— 把这条 PostgreSQL 语义钉成可执行事实。
   *
   * 评审推断的环依赖"最终闸的 `settings FOR SHARE` 会排在 PATCH 的 `FOR UPDATE` 等待者
   * 身后"。实测(PostgreSQL 16)**不会**:行锁只与**持有者**比相容性,一个新的
   * `FOR SHARE` 与既有 `FOR SHARE` 持有者相容 ⇒ 立即获准,直接越过正在排队的 `FOR UPDATE`。
   * 于是最终闸根本不阻塞,环闭不上 —— 那条特定调度在修复前也不死锁(见 PR 报告)。
   *
   * 这条用例存在的意义有两层:
   * ① 让"我复现不出评审那条死锁"这句话有**可执行的依据**,而不是一句断言;
   * ② 一旦哪天升级 PG 或改了锁模式(比如闸把 User 提到 `FOR UPDATE`、或 bind 把 settings
   *    改成 `FOR UPDATE`),本用例会红 —— 那正是需要重新审这条环的时刻。
   *
   * ⚠️ 结论**不是**"锁序无所谓":锁序倒置是真的(bind 是 settings→User,旧闸是 User→settings),
   * 只是当前锁模式组合下还没有让它兑现的第三方。统一锁序是把"以后也兑现不了"变成结构性事实。
   */
  it('PG 语义护栏:与既有 SHARE 持有者相容的 FOR SHARE 不排在等待中的 FOR UPDATE 身后', async () => {
    const holderStarted = deferred();
    const releaseHolder = deferred();
    const events: string[] = [];

    // ① 持有者:settings FOR SHARE
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "wecom_settings" ORDER BY "id" FOR SHARE`);
      holderStarted.resolve();
      await releaseHolder.promise;
      events.push('holder:released');
    }, TX_BUDGET);
    await holderStarted.promise;

    // ② 排队者:settings FOR UPDATE(与 ① 冲突,必然等待)
    const waiter = prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "wecom_settings" ORDER BY "id" FOR UPDATE`);
      events.push('for-update:granted');
    }, TX_BUDGET);
    await waitForSettingsWaiters(1);

    // ③ 后到的 FOR SHARE:如果它排在 ② 身后,这里会超时;实测立即获准。
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '3s'`);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "wecom_settings" ORDER BY "id" FOR SHARE`);
      events.push('late-for-share:granted');
    }, TX_BUDGET);

    releaseHolder.resolve();
    await Promise.all([holder, waiter]);

    // 后到的 FOR SHARE 抢在 FOR UPDATE **之前**拿到 —— 环的第 ④ 步因此不成立。
    expect(events).toEqual(['late-for-share:granted', 'holder:released', 'for-update:granted']);
  });

  // 反向锁:上面那条若被"闸干脆不锁 settings 了"之类的改法弄绿,这条会红 ——
  // settings 必须仍然是**锁后复读**,关掉开关的事务与本闸之间不能有中间态。
  it('反向:最终闸仍然锁后复读 settings —— 并发关掉 messageEnabled 后必得 channel-disabled', async () => {
    const active = await settingsService.getActiveSettings();
    const expected = {
      corpId: active!.corpId!,
      configurationGeneration: active!.configurationGeneration,
    };
    await settingsService.updateSettings({ messageEnabled: false }, adminPayload, AUDIT_META);

    const outcome = await prisma.$transaction(
      async (tx) =>
        (await dispatch.authorizeDurableRecipient(tx, notification, memberId, expected)).outcome,
      TX_BUDGET,
    );
    expect(outcome).toBe('channel-disabled');
  });
});
